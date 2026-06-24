const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000; 

app.use(express.json());

// Deixa a pasta de uploads pública para o navegador conseguir carregar as imagens pelas URLs
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Garante que a pasta raiz de uploads exista
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// Inicialização do arquivo JSON (Banco de dados temporário)
const DB_FILE = './dispositivos.json';
try {
    if (!fs.existsSync(DB_FILE) || fs.readFileSync(DB_FILE, 'utf8').trim() === '') {
        fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
    } else {
        JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
    }
} catch (e) {
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
        console.error("⚠️ Erro ao ler banco de dados para organizar fotos.");
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

        console.log(`💾 [API] Foto organized com sucesso! Armazenada em: ${caminhoFinalDoArquivo}`);
        res.status(200).send('OK');
    });
});

// ROTA: Puxar relatório geral de conexões E arquivos salvos no navegador (JSON)
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
                    blueprint = estruturaPastas[usuario] = fs.readdirSync(caminhoUsuario);
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

// ROTA DO DASHBOARD: Interface Web em Dark Mode estilizada com TailwindCSS
app.get('/dashboard', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>OmniGuardian - Painel de Controle</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap">
        <style>body { font-family: 'Plus Jakarta Sans', sans-serif; }</style>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen">
        
        <header class="border-b border-slate-900 bg-slate-900/50 backdrop-blur sticky top-0 z-50">
            <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
                <div class="flex items-center gap-3">
                    <span class="text-2xl">🛡️</span>
                    <div>
                        <h1 class="text-xl font-bold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">OmniGuardian</h1>
                        <p class="text-xs text-slate-400">Monitoramento IoT em Tempo Real</p>
                    </div>
                </div>
                <button onclick="carregarDados()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-sm font-semibold rounded-lg transition shadow-lg shadow-blue-600/20 active:scale-95">🔄 Atualizar Painel</button>
            </div>
        </header>

        <main class="max-w-7xl mx-auto px-4 py-8 space-y-12">
            
            <section>
                <div class="flex items-center gap-2 mb-6">
                    <span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                    <h2 class="text-lg font-bold text-slate-300">Equipamentos Ativos</h2>
                </div>
                <div id="grid-dispositivos" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <p class="text-sm text-slate-500 col-span-full">Carregando dispositivos...</p>
                </div>
            </section>

            <section>
                <h2 class="text-lg font-bold text-slate-300 mb-6 flex items-center gap-2">📸 Capturas de Imagem Recentes</h2>
                <div id="container-usuarios" class="space-y-10">
                    <p class="text-sm text-slate-500">Carregando imagens...</p>
                </div>
            </section>

        </main>

        <script>
            function carregarDados() {
                fetch('/api/iot/overview')
                    .then(res => res.json())
                    .then(data => {
                        const gridDisp = document.getElementById('grid-dispositivos');
                        gridDisp.innerHTML = '';
                        
                        if (data.dispositivos_registrados.length === 0) {
                            gridDisp.innerHTML = '<p class="text-sm text-slate-500 col-span-full bg-slate-900 border border-slate-800 p-4 rounded-xl">Nenhum hardware registrou conexão ainda.</p>';
                        } else {
                            data.dispositivos_registrados.forEach(disp => {
                                const dataFormatada = new Date(disp.last_seen).toLocaleString('pt-BR');
                                gridDisp.innerHTML += \`
                                    <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-xl space-y-3 relative overflow-hidden group">
                                        <div class="absolute top-0 right-0 w-24 h-24 bg-blue-600/5 rounded-full blur-xl group-hover:bg-blue-600/10 transition"></div>
                                        <div class="flex justify-between items-start">
                                            <span class="text-xs font-bold px-2.5 py-1 bg-slate-800 border border-slate-700 text-blue-400 rounded-md">\${disp.device_model}</span>
                                            <span class="text-xs text-emerald-400 font-semibold flex items-center gap-1">● Online</span>
                                        </div>
                                        <div>
                                            <p class="text-xs text-slate-400 font-medium">ID DO USUÁRIO</p>
                                            <p class="text-base font-bold text-slate-200">\${disp.user_id}</p>
                                        </div>
                                        <div class="pt-2 border-t border-slate-800/60 grid grid-cols-2 gap-2 text-xs text-slate-400">
                                            <div>
                                                <p class="text-[10px] text-slate-500">ENDEREÇO MAC</p>
                                                <p class="font-mono text-slate-300 font-medium">\-- ${'${disp.mac_address}'}</p>
                                            </div>
                                            <div>
                                                <p class="text-[10px] text-slate-500">ÚLTIMO SINAL</p>
                                                <p class="text-slate-300 font-medium">\${dataFormatada}</p>
                                            </div>
                                        </div>
                                    </div>
                                \`;
                            });
                        }

                        const containerUsers = document.getElementById('container-usuarios');
                        containerUsers.innerHTML = '';

                        const listaUsuarios = Object.keys(data.arquivos_armazenados);
                        
                        if (listaUsuarios.length === 0) {
                            containerUsers.innerHTML = '<p class="text-sm text-slate-500 bg-slate-900 border border-slate-800 p-4 rounded-xl">Nenhuma imagem armazenada no servidor.</p>';
                            return;
                        }

                        listaUsuarios.forEach(userId => {
                            const fotos = data.arquivos_armazenados[userId];
                            
                            let htmlGaleria = \`
                                <div class="bg-slate-900/40 border border-slate-900 p-6 rounded-2xl space-y-4">
                                    <div class="flex items-center gap-2 border-b border-slate-800/60 pb-3">
                                        <span class="text-base">📁</span>
                                        <h3 class="font-bold text-slate-200 text-base">Pasta do Usuário: <span class="text-indigo-400">\${userId}</span></h3>
                                        <span class="text-xs bg-slate-800 px-2 py-0.5 rounded text-slate-400 font-medium">\${fotos.length} fotos</span>
                                    </div>
                                    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                            \`;

                            if (fotos.length === 0) {
                                htmlGaleria += '<p class="text-xs text-slate-500 col-span-full">Esta pasta está vazia por enquanto.</p>';
                            } else {
                                [...fotos].reverse().forEach(fotoNome => {
                                    htmlGaleria += \`
                                        <div class="bg-slate-900 border border-slate-800/80 rounded-xl overflow-hidden group hover:border-slate-700 transition shadow-md">
                                            <div class="aspect-video bg-slate-950 overflow-hidden relative">
                                                <img src="/uploads/\${userId}/\
\${fotoNome}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" alt="Captura IoT" />
                                            </div>
                                            <div class="p-2.5 text-[10px] text-slate-400 bg-slate-900/90 font-mono truncate">
                                                \${fotoNome}
                                            </div>
                                        </div>
                                    \`;
                                });
                            }

                            htmlGaleria += \`</div></div>\`;
                            containerUsers.innerHTML += htmlGaleria;
                        });
                    })
                    .catch(err => console.error("Erro ao carregar dados:", err));
            }

            carregarDados();
            setInterval(carregarDados, 15000);
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor OmniGuardian Online na porta ${PORT}!`);
});
