const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
// ✅ CORRIGIDO: Escuta a porta injetada pelo Render ou a 3000 caso seja local
const PORT = process.env.PORT || 3000; 

app.use(express.json());

// Garante que a pasta raiz de uploads e o arquivo de dispositivos existam
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const DB_FILE = './dispositivos.json';
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));

// Configura o multer para salvar temporariamente os arquivos na raiz de uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'foto-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ROTA: Registro de Dispositivos (Vincula o Usuário à Câmera)
app.post('/api/iot/register-device', (req, res) => {
    const { user_id, mac_address, device_model } = req.body;

    if (!user_id || !mac_address) {
        return res.status(400).send('Erro: Dados incompletos para registro.');
    }

    const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const deviceIndex = dbData.findIndex(item => item.mac_address === mac_address);

    const deviceInfo = {
        user_id,
        mac_address,
        device_model: device_model || "ESP32-CAM OmniGuardian",
        last_seen: new Date().toISOString()
    };

    if (deviceIndex >= 0) {
        dbData[deviceIndex] = deviceInfo;
    } else {
        dbData.push(deviceInfo);
    }

    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
    console.log(`\n📲 [API] Dispositivo Mapeado: Usuário ${user_id} vinculado à Câmera ${mac_address}`);
    res.status(200).json({ status: "success", message: "Dispositivo registrado com sucesso!" });
});

// ROTA: Recebe a foto, identifica o usuário dono do MAC e organiza em pastas
app.post('/api/iot/lighttrap/', upload.single('image'), (req, res) => {
    const macAddress = req.body.mac_address;
    const file = req.file;

    console.log(`\n📸 [API] Foto recebida da Câmera MAC: ${macAddress || 'Desconhecido'}`);

    if (!file) {
        return res.status(400).send('Erro: Arquivo de imagem ausente.');
    }

    // 🕵️‍♂️ Passo 1: Busca qual ID de Usuário é dono desse MAC no dispositivos.json
    let userId = 'usuario_desconhecido';
    if (fs.existsSync(DB_FILE)) {
        const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const linkCorrespondente = dbData.find(item => item.mac_address === macAddress);

        if (linkCorrespondente && linkCorrespondente.user_id) {
            userId = linkCorrespondente.user_id; // Encontrou o ID real (Ex: USR-8742)
        }
    }

    // 📁 Passo 2: Define o caminho da pasta exclusiva daquele usuário (Ex: uploads/USR-8742/)
    const pastaDoUsuario = path.join(__dirname, 'uploads', userId);

    // Se a pasta do usuário não existir, cria ela na hora de forma dinâmica
    if (!fs.existsSync(pastaDoUsuario)) {
        fs.mkdirSync(pastaDoUsuario, { recursive: true });
        console.log(`📁 [API] Nova pasta criada para o usuário: ${userId}`);
    }

    // 🎯 Passo 3: Move o arquivo da raiz de uploads para dentro da pasta do usuário correto
    const caminhoFinalDoArquivo = path.join(pastaDoUsuario, file.filename);

    fs.rename(file.path, caminhoFinalDoArquivo, (err) => {
        if (err) {
            console.error(`❌ [API] Erro ao organizar arquivo na pasta do usuário:`, err);
            return res.status(500).send('Erro interno ao processar e salvar imagem.');
        }

        console.log(`💾 [API] Foto organizada com sucesso! Armazenada em: ${caminhoFinalDoArquivo}`);
        res.status(200).send('OK');
    });
});

// ROTA: Puxar relatório geral de conexões no navegador
app.get('/api/iot/overview', (req, res) => {
    const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    res.status(200).json(dbData);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor OmniGuardian Online na porta ${PORT}!`);
});
