const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000; 

app.use(express.json());

// 📁 Garante que a pasta raiz de uploads exista
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// 🛡️ Inicialização Blindada do arquivo JSON (Evita crashes se estiver vazio ou corrompido)
const DB_FILE = './dispositivos.json';
try {
    if (!fs.existsSync(DB_FILE) || fs.readFileSync(DB_FILE, 'utf8').trim() === '') {
        fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
    } else {
        JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); // Testa se o JSON é válido
    }
} catch (e) {
    // Se o arquivo estiver corrompido, reseta ele para um array vazio com segurança
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
}

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

    try {
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
    } catch (err) {
        res.status(500).send('Erro ao salvar dispositivo.');
    }
});

// ROTA: Recebe a foto, identifica o usuário dono do MAC e organiza em pastas
app.post('/api/iot/lighttrap/', upload.single('image'), (req, res) => {
    const macAddress = req.body.mac_address;
    const file = req.file;

    console.log(`\n📸 [API] Foto recebida da Câmera MAC: ${macAddress || 'Desconhecido'}`);

    if (!file) {
        return res.status(400).send('Erro: Arquivo de imagem ausente.');
    }

    let userId = 'usuario_desconhecido';
    try {
        const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const linkCorrespondente = dbData.find(item => item.mac_address === macAddress);
        if (linkCorrespondente && linkCorrespondente.user_id) {
            userId = linkCorrespondente.user_id;
        }
    } catch (e) {
        console.error("⚠️ Erro ao ler banco de dados para organizar fotos, usando diretório padrão.");
    }

    const pastaDoUsuario = path.join(__dirname, 'uploads', userId);

    if (!fs.existsSync(pastaDoUsuario)) {
        fs.mkdirSync(pastaDoUsuario, { recursive: true });
        console.log(`📁 [API] Nova pasta criada para o usuário: ${userId}`);
    }

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

// ROTA: Puxar relatório geral de conexões E arquivos salvos no navegador
app.get('/api/iot/overview', (req, res) => {
    try {
        const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        let estruturaPastas = {};
        const caminhoUploads = path.join(__dirname, 'uploads');
        
        if (fs.existsSync(caminhoUploads)) {
            const usuarios = fs.readdirSync(caminhoUploads);
            usuarios.forEach(usuario => {
                const caminhoUsuario = path.join(caminhoUploads, usuario);
                if (fs.statSync(caminhoUsuario).isDirectory()) {
                    estruturaPastas[usuario] = fs.readdirSync(caminhoUsuario);
                }
            });
        }

        res.status(200).json({
            dispositivos_registrados: dbData,
            arquivos_armazenados: estruturaPastas
        });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao gerar relatório geral." });
    }
});

// ✅ ALTERAÇÃO DE PORTA: Removido o '0.0.0.0' fixo para permitir que o Render faça o binding nativo
app.listen(PORT, () => {
    console.log(`🚀 Servidor OmniGuardian Online na porta ${PORT}!`);
});
