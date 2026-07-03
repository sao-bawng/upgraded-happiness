require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
    Collection,
    MessageFlags,
    Partials,
} = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mcUtil = require('minecraft-server-util');

// =========================================================================
// KIỂM TRA BIẾN MÔI TRƯỜNG (.env) — Bot sẽ dừng ngay và báo lỗi rõ ràng
// nếu thiếu biến quan trọng, thay vì chạy rồi lỗi "undefined" khó hiểu.
// =========================================================================
const REQUIRED_ENV = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'GEMINI_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]?.trim());
if (missingEnv.length > 0) {
    console.error(`🔴 Thiếu biến môi trường trong file .env: ${missingEnv.join(', ')}`);
    console.error('👉 Xem file .env.example để biết cần khai báo những gì.');
    process.exit(1);
}

const {
    DISCORD_TOKEN,
    DISCORD_GUILD_ID,
    GEMINI_API_KEY,
    GEMINI_MODEL = 'gemini-2.5-flash',
    MC_SERVER_IP = 'node1.gachcloud.net',
    MC_SERVER_PORT = '25699',
} = process.env;

// =========================================================================
// WEB SERVER NHỎ — chỉ để Render nhận diện có port đang lắng nghe (bắt buộc
// với gói Web Service), và để UptimeRobot có endpoint ping giữ bot không bị
// ngủ trên gói free. Không liên quan gì tới logic Discord bot cả.
// =========================================================================
const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('🤖 Bot đang chạy ngon lành!');
}).listen(PORT, () => {
    console.log(`🌐 Web server đang lắng nghe ở port ${PORT} (dùng cho Render/UptimeRobot)`);
});

// Khởi tạo Discord Bot
// Lưu ý: cần bật "MESSAGE CONTENT INTENT" trong Discord Developer Portal
// (Bot > Privileged Gateway Intents) thì bot mới đọc được nội dung tin nhắn khi bị ping.
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});

// Khởi tạo AI Gemini
const ai = new GoogleGenerativeAI(GEMINI_API_KEY);

// Thông tin server Minecraft — phiên bản hiển thị cố định, còn IP/Port lấy từ .env
const SERVER_INFO = {
    versionPC: '1.21.11 ( PC )',
    versionPE: '1.26.30 ( PE )',
    ip: MC_SERVER_IP,
    port: MC_SERVER_PORT,
};

// Chống spam khi ping bot hỏi AI: mỗi người chỉ được hỏi 1 lần mỗi 10 giây (đỡ tốn quota Gemini)
const askCooldown = new Collection();
const ASK_COOLDOWN_MS = 10_000;

// Xác suất hiển thị GIF cho các lệnh tương tác (0 -> 1). Không hiện GIF mỗi lần nữa,
// mà random khoảng 1/4 lần mới hiện — đỡ bị lặp/spam gif liên tục.
const GIF_CHANCE = 0.25;

// Lấy GIF phản ứng từ API miễn phí otakugifs.xyz thay vì link cứng dễ hỏng
async function getReactionGif(reaction) {
    try {
        const res = await fetch(`https://api.otakugifs.xyz/gif?reaction=${reaction}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data.url;
    } catch (err) {
        console.error(`🔴 Không lấy được GIF cho "${reaction}":`, err.message);
        return null; // Không có GIF thì vẫn trả lời bình thường, chỉ thiếu ảnh thôi
    }
}

// =========================================================================
// CÁC LỆNH TƯƠNG TÁC (slap/tysm) — gộp chung config để dễ thêm bớt,
// khỏi phải viết lặp lại code cho từng lệnh một.
// =========================================================================
const REACTION_DEFS = [
    {
        name: 'slap',
        description: 'Tát một thk lờ nào đó',
        reaction: 'slap',
        emoji: '⚡',
        color: '#ff4500',
        text: (u, t) => `**${u}** đã vả bôm bốp **${t}** chừa nha cu`,
    },
    {
        name: 'tysm',
        description: 'Cảm ơn ai đó thật nhiều (thank you so much)',
        reaction: 'thumbsup',
        emoji: '🙏',
        color: '#f1c40f',
        text: (u, t) => `**${u}** gửi lời cảm ơn cực kỳ nhiều tới **${t}**, tysm nha 💛`,
    },
];

// =========================================================================
// HELPER — hash chuỗi (dùng cho /rate, /ship để ra kết quả "có vẻ nhất quán"
// thay vì random 100% mỗi lần gọi), vẽ thanh progress bar, chọn màu theo %.
// =========================================================================
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function makeBar(percent, size = 10) {
    const filled = Math.round((percent / 100) * size);
    return '🟩'.repeat(filled) + '⬜'.repeat(size - filled);
}

function percentColor(percent) {
    if (percent < 34) return '#e74c3c';
    if (percent < 67) return '#f1c40f';
    return '#2ecc71';
}

function rateComment(percent) {
    if (percent <= 20) return '😬 Thôi... skibidi r';
    if (percent <= 40) return '🙂 Tạm tạm, cần cố gắng htrêm.';
    if (percent <= 60) return '😊 Cũng ổn áp đó fen';
    if (percent <= 80) return '🔥 OMGG';
    return '👑 Đỉnh nóc kịch trần bay phấp phớiiiiiii';
}

function shipComment(percent) {
    if (percent <= 20) return '💔 Thôi làm bạn cho lành...';
    if (percent <= 40) return '🤔 Cần thêm thời gian tìm hiểu ( con đà điểu )';
    if (percent <= 60) return '🌱 Cũng có hi vọng đó nha zzz';
    if (percent <= 80) return '💖 Đẹp đôi ghê, đi đâu cũng có nhau cây cau';
    return '💍 Trời sinh một cặp, mau đi đăng ký kết hôn ( đánh gôn )';
}

const EIGHTBALL_ANSWERS = [
    'Chắc chắn rồi 💯',
    'Có thể lắm à nha 🤔',
    'Hên xui đó, thử xem sao 🎲',
    'Hỏi lại sau đi, giờ chưa rõ 🌫️',
    'Không đời nào đâu 🙅',
    'Tin ta đi, có đó 👍',
    'Mông lung như một trò đùa 😵',
    'Chắc là không đâu 😬',
    '100% luôn á 🔥',
    'Câu này khó nói lắm à nha 🎱',
];

// 1. Định nghĩa danh sách các lệnh gạch chéo (/)
const otherCommandBuilders = [
    new SlashCommandBuilder()
        .setName('minecraft')
        .setDescription('Xem thông tin kết nối Server Minecraft'),

    new SlashCommandBuilder()
        .setName('rate')
        .setDescription('Để bot chấm điểm một thứ gì đó')
        .addStringOption((option) =>
            option.setName('thu').setDescription('Thứ bạn muốn được chấm điểm').setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('ship')
        .setDescription('Ghép đôi xem hợp nhau bao nhiêu %')
        .addUserOption((option) => option.setName('nguoi_1').setDescription('Người thứ nhất').setRequired(true))
        .addUserOption((option) => option.setName('nguoi_2').setDescription('Người thứ hai').setRequired(true)),

    new SlashCommandBuilder()
        .setName('8ball')
        .setDescription('Hỏi quả cầu tiên tri bất cứ điều gì')
        .addStringOption((option) => option.setName('cau_hoi').setDescription('Câu hỏi của bạn').setRequired(true)),

    new SlashCommandBuilder().setName('coinflip').setDescription('Tung đồng xu ngửa hay sấp'),

    new SlashCommandBuilder()
        .setName('rps')
        .setDescription('Chơi oẳn tù tì với bot')
        .addStringOption((option) =>
            option
                .setName('lua_chon')
                .setDescription('Kéo, Búa hay Bao')
                .setRequired(true)
                .addChoices(
                    { name: 'Kéo ✌️', value: 'keo' },
                    { name: 'Búa ✊', value: 'bua' },
                    { name: 'Bao ✋', value: 'bao' }
                )
        ),
];

const reactionCommandBuilders = REACTION_DEFS.map((def) =>
    new SlashCommandBuilder()
        .setName(def.name)
        .setDescription(def.description)
        .addUserOption((option) =>
            option.setName('user').setDescription('Người bạn muốn tương tác').setRequired(true)
        )
);

const commands = [...otherCommandBuilders, ...reactionCommandBuilders].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

client.once('ready', async () => {
    console.log(`🤖 Bot Discord ${client.user.tag} đã online!`);

    try {
        console.log('⏳ Đang đăng ký các lệnh (/) vào Server Discord...');
        await rest.put(Routes.applicationGuildCommands(client.user.id, DISCORD_GUILD_ID), {
            body: commands,
        });
        console.log('✅ Đã cập nhật toàn bộ lệnh (/) thành công!');
    } catch (error) {
        console.error('🔴 Lỗi khi đăng ký lệnh (/):', error);
    }
});

// Helper dựng embed nền tảng dùng chung cho mọi lệnh — đồng bộ footer + timestamp
// để cả bot trông thống nhất, chuyên nghiệp hơn thay vì mỗi lệnh một kiểu.
function createBaseEmbed(color) {
    return new EmbedBuilder()
        .setColor(color)
        .setTimestamp()
        .setFooter({
            text: client.user.username,
            iconURL: client.user.displayAvatarURL(),
        });
}

// Helper dựng embed cho các lệnh tương tác (slap/tysm/...) — gộp lại để đỡ lặp code
async function buildInteractionEmbed({ emoji, color, text, reaction, invoker, target }) {
    const embed = createBaseEmbed(color)
        .setDescription(`${emoji} ${text}`)
        .setAuthor({ name: invoker.username, iconURL: invoker.displayAvatarURL({ size: 128 }) });

    if (target) {
        embed.setThumbnail(target.displayAvatarURL({ size: 256 }));
    }

    // Chỉ hiện GIF ngẫu nhiên theo GIF_CHANCE, không phải lần nào cũng hiện
    if (Math.random() < GIF_CHANCE) {
        const gifUrl = await getReactionGif(reaction);
        if (gifUrl) embed.setImage(gifUrl);
    }

    return embed;
}

// =========================================================================
// TRẢ LỜI AI KHI BỊ PING (@bot + nội dung) — thay cho lệnh /ask cũ.
// Chỉ cần tag bot trong tin nhắn (kèm 1 câu hỏi) là bot sẽ trả lời bằng Gemini.
// =========================================================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return; // Bỏ qua tin nhắn từ bot khác (kể cả chính nó)
    if (!message.mentions.has(client.user.id)) return; // Chỉ trả lời khi bị ping trực tiếp

    // Bóc nội dung câu hỏi ra khỏi tin nhắn, loại bỏ phần mention (<@id> / <@!id>)
    const prompt = message.content.replace(/<@!?\d+>/g, '').trim();

    if (!prompt) {
        return message.reply('Ping t làm gì mà hổng có hỏi gì hết vậy 😅 Hỏi gì đi rồi t trả lời cho!');
    }

    const now = Date.now();
    const lastUsed = askCooldown.get(message.author.id) || 0;
    if (now - lastUsed < ASK_COOLDOWN_MS) {
        const remain = ((ASK_COOLDOWN_MS - (now - lastUsed)) / 1000).toFixed(1);
        return message.reply(`M hỏi nhanh quá! Chờ **${remain}s** nữa rồi hỏi tiếp...`);
    }
    askCooldown.set(message.author.id, now);

    try {
        await message.channel.sendTyping();

        const model = ai.getGenerativeModel({ model: GEMINI_MODEL });
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

        // Embed cho phép nội dung dài hơn tin nhắn thường (giới hạn description ~4096 ký tự)
        const finalResponse = aiResponse.length > 4000 ? aiResponse.substring(0, 4000) + '...' : aiResponse;
        const shortPrompt = prompt.length > 1024 ? prompt.slice(0, 1021) + '...' : prompt;

        const askEmbed = createBaseEmbed('#8e44ad')
            .setTitle('🤖 AI trả lời')
            .addFields({ name: '❓ Câu hỏi', value: shortPrompt })
            .setDescription(finalResponse);

        await message.reply({ embeds: [askEmbed] });
    } catch (error) {
        console.error('🔴 Lỗi AI Gemini:', error);
        const errorEmbed = createBaseEmbed('#e74c3c')
            .setTitle('🔴 Lỗi rồi!')
            .setDescription('AI gặp lỗi rồi hoặc API key có vấn đề, ông kiểm tra lại thử xem!');
        await message.reply({ embeds: [errorEmbed] });
    }
});

// 2. Xử lý logic khi người dùng gõ lệnh
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, user } = interaction;

    // --- LỆNH MINECRAFT ---
    if (commandName === 'minecraft') {
        await interaction.deferReply();

        const mcEmbed = createBaseEmbed('#2f3136')
            .setTitle('⛏️ SERVER MINECRAFT')
            .addFields(
                { name: '📌 Phiên bản', value: `🔹 **${SERVER_INFO.versionPC}**\n🔸 **${SERVER_INFO.versionPE}**`, inline: false },
                { name: '🔌 Cổng (Port)', value: `\`${SERVER_INFO.port}\``, inline: true },
                { name: '🌐 IP Bedrock (PE)', value: `\`${SERVER_INFO.ip}\``, inline: false },
                { name: '💻 IP Java (PC)', value: `\`${SERVER_INFO.ip}:${SERVER_INFO.port}\``, inline: false }
            )
            .setFooter({ text: 'Chúc mn chơi game vui vẻ! 🎮', iconURL: client.user.displayAvatarURL() });

        return await interaction.editReply({ embeds: [mcEmbed] });
    }

    // --- LỆNH RATE ---
    if (commandName === 'rate') {
        const thing = options.getString('thu');
        const percent = hashString(thing.toLowerCase()) % 101;

        const rateEmbed = createBaseEmbed(percentColor(percent))
            .setTitle('📊 Kết quả chấm điểm')
            .setAuthor({ name: user.username, iconURL: user.displayAvatarURL({ size: 128 }) })
            .setDescription(`**${thing}**\n\n${makeBar(percent)}  **${percent}/100**\n\n${rateComment(percent)}`);

        return await interaction.reply({ embeds: [rateEmbed] });
    }

    // --- LỆNH SHIP ---
    if (commandName === 'ship') {
        const userA = options.getUser('nguoi_1');
        const userB = options.getUser('nguoi_2');
        const percent = hashString([userA.id, userB.id].sort().join('-')) % 101;

        const shipEmbed = createBaseEmbed(percentColor(percent))
            .setTitle('💘 Kết quả ghép đôi')
            .setDescription(
                `**${userA.username}** 💞 **${userB.username}**\n\n${makeBar(percent)}  **${percent}%**\n\n${shipComment(percent)}`
            );

        return await interaction.reply({ embeds: [shipEmbed] });
    }

    // --- LỆNH 8BALL ---
    if (commandName === '8ball') {
        const question = options.getString('cau_hoi');
        const answer = EIGHTBALL_ANSWERS[Math.floor(Math.random() * EIGHTBALL_ANSWERS.length)];

        const ballEmbed = createBaseEmbed('#2c3e50')
            .setTitle('🔮 Quả Cầu Tiên Tri')
            .addFields({ name: '❓ Câu hỏi', value: question }, { name: '✨ Trả lời', value: answer });

        return await interaction.reply({ embeds: [ballEmbed] });
    }

    // --- LỆNH COINFLIP ---
    if (commandName === 'coinflip') {
        const result = Math.random() < 0.5 ? 'Ngửa 🌕' : 'Sấp 🌑';

        const coinEmbed = createBaseEmbed('#f1c40f')
            .setTitle('🪙 Tung Đồng Xu')
            .setDescription(`Kết quả: **${result}**`);

        return await interaction.reply({ embeds: [coinEmbed] });
    }

    // --- LỆNH RPS (oẳn tù tì) ---
    if (commandName === 'rps') {
        const choices = ['keo', 'bua', 'bao'];
        const labels = { keo: 'Kéo ✌️', bua: 'Búa ✊', bao: 'Bao ✋' };
        const userChoice = options.getString('lua_chon');
        const botChoice = choices[Math.floor(Math.random() * choices.length)];

        let resultText;
        if (userChoice === botChoice) {
            resultText = '🤝 Huề rồi, chơi lại đi!';
        } else if (
            (userChoice === 'keo' && botChoice === 'bao') ||
            (userChoice === 'bua' && botChoice === 'keo') ||
            (userChoice === 'bao' && botChoice === 'bua')
        ) {
            resultText = '🎉 Bạn thắng rồi đó!';
        } else {
            resultText = '😅 Bot thắng rồi, làm lại ván nữa đi!';
        }

        const rpsEmbed = createBaseEmbed('#1abc9c')
            .setTitle('✊✌️✋ Oẳn Tù Tì')
            .addFields(
                { name: 'Bạn chọn', value: labels[userChoice], inline: true },
                { name: 'Bot chọn', value: labels[botChoice], inline: true }
            )
            .setDescription(resultText);

        return await interaction.reply({ embeds: [rpsEmbed] });
    }

    // --- CÁC LỆNH TƯƠNG TÁC (slap/tysm) ---
    const reactionDef = REACTION_DEFS.find((def) => def.name === commandName);
    if (reactionDef) {
        const targetUser = options.getUser('user');
        const embed = await buildInteractionEmbed({
            emoji: reactionDef.emoji,
            color: reactionDef.color,
            text: reactionDef.text(user.username, targetUser.username),
            reaction: reactionDef.reaction,
            invoker: user,
            target: targetUser,
        });
        return await interaction.reply({ embeds: [embed] });
    }
});

// Bắt các lỗi không mong muốn để bot không bị crash im lặng ngoài log
process.on('unhandledRejection', (error) => {
    console.error('🔴 Lỗi không được xử lý (unhandledRejection):', error);
});

// Đăng nhập bot
client.login(DISCORD_TOKEN);