const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000; 

app.use(express.json());

// 🛡️ CONFIGURAÇÃO DE DIRETÓRIO SEGURO:
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'dispositivos.json');

app.use('/uploads', express.static(UPLOADS_DIR));

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

try {
    if (!fs.existsSync(DB_FILE) || fs.readFileSync(DB_FILE, 'utf8').trim() === '') {
        fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
    } else {
        JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
    }
} catch (e) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
}

// 🎛️ CONTROLE DE STREAMING DE VÍDEO EM TEMPO REAL (MJPEG)
const streamStatus = {};  
const liveClients = {};   

// Endpoint para o ESP32 checar se o painel web está solicitando transmissão de vídeo
app.get('/api/iot/stream-status', (req, res) => {
    const mac = req.query.mac;
    res.json({ stream: !!streamStatus[mac] });
});

// Endpoint chamado pelo Dashboard para ligar/desligar o streaming da armadilha
app.post('/api/iot/toggle-stream', (req, res) => {
    const { mac_address, action } = req.body;
    if (action === 'start') {
        streamStatus[mac_address] = true;
        console.log(`🎥 [STREAM] Transmissão de vídeo iniciada para: ${mac_address}`);
    } else {
        streamStatus[mac_address] = false;
        console.log(`🛑 [STREAM] Transmissão de vídeo encerrada para: ${mac_address}`);
        if (liveClients[mac_address]) {
            liveClients[mac_address].forEach(c => { try { c.end(); } catch(e){} });
            liveClients[mac_address] = [];
        }
    }
    res.json({ status: "success", stream: streamStatus[mac_address] });
});

// Endpoint ultra-rápido para o ESP32 descarregar os buffers binários jpegs brutos do vídeo
app.post('/api/iot/stream-frame', express.raw({ type: 'image/jpeg', limit: '500kb' }), (req, res) => {
    const macAddress = req.headers['x-mac-address'];
    if (!macAddress || !req.body || req.body.length === 0) {
        return res.status(400).send('Dados de frame inválidos.');
    }

    // Se houver navegadores sintonizados no dashboard, repassa o frame imediatamente
    if (liveClients[macAddress] && liveClients[macAddress].length > 0) {
        const frame = req.body;
        liveClients[macAddress].forEach(clientRes => {
            try {
                clientRes.write(`--frame\r\n`);
                clientRes.write(`Content-Type: image/jpeg\r\n`);
                clientRes.write(`Content-Length: ${frame.length}\r\n\r\n`);
                clientRes.write(frame);
                clientRes.write(`\r\n`);
            } catch(e) {
                // Remove conexões corrompidas
            }
        });
    }
    res.send('OK');
});

// Rota que o Dashboard pluga na tag <img> para renderizar o vídeo contínuo por boundaries
app.get('/api/iot/live/:mac', (req, res) => {
    const mac = req.params.mac;
    
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Pragma', 'no-cache');

    if (!liveClients[mac]) liveClients[mac] = [];
    liveClients[mac].push(res);

    req.on('close', () => {
        liveClients[mac] = liveClients[mac].filter(c => c !== res);
        if (liveClients[mac].length === 0) {
            // Se o usuário fechou o modal ou saiu da página, manda o ESP32 desligar o sensor
            streamStatus[mac] = false;
            console.log(`🛑 [STREAM] Sem espectadores na página. Desligando streaming do MAC: ${mac}`);
        }
    });
});

// 🧹 ROTINA DE LIMPEZA CRÍTICA SEMANAL
function limparFotosAntigas() {
    if (!fs.existsSync(UPLOADS_DIR)) return;
    const AGORA = Date.now();
    const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
    try {
        const usuarios = fs.readdirSync(UPLOADS_DIR);
        usuarios.forEach(usuario => {
            const caminhoUsuario = path.join(UPLOADS_DIR, usuario);
            if (fs.statSync(caminhoUsuario).isDirectory()) {
                const fotos = fs.readdirSync(caminhoUsuario);
                fotos.forEach(foto => {
                    const caminhoFoto = path.join(caminhoUsuario, foto);
                    const statusFoto = fs.statSync(caminhoFoto);
                    if (AGORA - statusFoto.mtimeMs > SETE_DIAS_MS) {
                        fs.unlinkSync(caminhoFoto);
                        console.log(`🗑️ [LIMPEZA] Foto antiga removida: ${foto}`);
                    }
                });
            }
        });
    } catch (err) {
        console.error("❌ Erro na limpeza de fotos:", err);
    }
}
limparFotosAntigas();
setInterval(limparFotosAntigas, 24 * 60 * 60 * 1000);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'foto-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.post('/api/iot/register-device', (req, res) => {
    const { user_id, mac_address, device_model } = req.body;
    if (!user_id || !mac_address) return res.status(400).send('Dados incompletos.');
    try {
        const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const deviceIndex = dbData.findIndex(item => item.mac_address === mac_address);
        const deviceInfo = { user_id, mac_address, device_model: device_model || "ESP32-CAM OmniGuardian", last_seen: new Date().toISOString() };
        if (deviceIndex >= 0) dbData[deviceIndex] = deviceInfo; else dbData.push(deviceInfo);
        fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
        res.status(200).json({ status: "success" });
    } catch (err) { res.status(500).send('Erro no registro.'); }
});

app.post('/api/iot/lighttrap/', upload.single('image'), (req, res) => {
    const macAddress = req.body.mac_address;
    const file = req.file;
    if (!file) return res.status(400).send('Imagem ausente.');
    let userId = 'usuario_desconhecido';
    try {
        const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const linkCorrespondente = dbData.find(item => item.mac_address === macAddress);
        if (linkCorrespondente) userId = linkCorrespondente.user_id;
    } catch (e) {}
    const pastaDoUsuario = path.join(UPLOADS_DIR, userId);
    if (!fs.existsSync(pastaDoUsuario)) fs.mkdirSync(pastaDoUsuario, { recursive: true });
    fs.rename(file.path, path.join(pastaDoUsuario, file.filename), (err) => {
        if (err) return res.status(500).send('Erro interno.');
        res.status(200).send('OK');
    });
});

app.get('/api/iot/overview', (req, res) => {
    try {
        const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        let estruturaPastas = {};
        if (fs.existsSync(UPLOADS_DIR)) {
            fs.readdirSync(UPLOADS_DIR).forEach(usuario => {
                const caminhoUsuario = path.join(UPLOADS_DIR, usuario);
                if (fs.statSync(caminhoUsuario).isDirectory()) estruturaPastas[usuario] = fs.readdirSync(caminhoUsuario);
            });
        }
        res.status(200).json({ dispositivos_registrados: dbData, arquivos_armazenados: estruturaPastas });
    } catch (err) { res.status(500).json({ erro: "Erro ao gerar relatório." }); }
});

app.get('/dashboard', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>LumiTrap - Painel de Controle</title>
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
                        <h1 class="text-xl font-bold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">LumiTrap</h1>
                        <p class="text-xs text-slate-400">Monitoramento em Tempo Real</p>
                    </div>
                </div>
                <button onclick="carregarDados()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-sm font-semibold rounded-lg transition shadow-lg shadow-blue-600/20 active:scale-95">🔄 Atualizar Painel</button>
            </div>
        </header>

        <main class="max-w-7xl mx-auto px-4 py-8 space-y-12">
            <section>
                <div class="flex items-center gap-2 mb-6">
                    <span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                    <h2 class="text-lg font-bold text-slate-300">Armadilhas Ativas</h2>
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
            // Função para alternar o estado do Streaming de Vídeo
            function toggleLiveStream(mac) {
                const container = document.getElementById(\`video-container-\${mac.replace(/:/g, '')}\`);
                const img = document.getElementById(\`video-feed-\${mac.replace(/:/g, '')}\`);
                const btn = document.getElementById(\`btn-stream-\${mac.replace(/:/g, '')}\`);
                
                if (container.classList.contains('hidden')) {
                    fetch('/api/iot/toggle-stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mac_address: mac, action: 'start' })
                    })
                    .then(res => res.json())
                    .then(data => {
                        container.classList.remove('hidden');
                        img.src = \`/api/iot/live/\${mac}\`;
                        btn.innerHTML = '🛑 Encerrar Monitoramento';
                        btn.classList.replace('bg-indigo-600', 'bg-red-600');
                        btn.classList.replace('hover:bg-indigo-500', 'hover:bg-red-500');
                    });
                } else {
                    fetch('/api/iot/toggle-stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mac_address: mac, action: 'stop' })
                    })
                    .then(res => res.json())
                    .then(data => {
                        container.classList.add('hidden');
                        img.src = '';
                        btn.innerHTML = '🎥 Ver Câmera Ao Vivo';
                        btn.classList.replace('bg-red-600', 'bg-indigo-600');
                        btn.classList.replace('hover:bg-red-500', 'hover:bg-indigo-500');
                    });
                }
            }

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
                                const macIdSanitizado = disp.mac_address.replace(/:/g, '');
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
                                                <p class="font-mono text-slate-300 font-medium">\${disp.mac_address}</p>
                                            </div>
                                            <div>
                                                <p class="text-[10px] text-slate-500">ÚLTIMO SINAL</p>
                                                <p class="text-slate-300 font-medium">\${dataFormatada}</p>
                                            </div>
                                        </div>
                                        
                                        <div class="pt-2">
                                            <button onclick="toggleLiveStream('\${disp.mac_address}')" id="btn-stream-\${macIdSanitizado}" class="w-full px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-bold rounded-xl transition active:scale-95 flex items-center justify-center gap-1">
                                                🎥 Ver Câmera Ao Vivo
                                            </button>
                                            <div id="video-container-\${macIdSanitizado}" class="hidden mt-3 rounded-xl overflow-hidden border border-slate-800 bg-slate-950 aspect-video relative flex items-center justify-center">
                                                <img id="video-feed-\${macIdSanitizado}" class="w-full h-full object-contain" src="" alt="Live feed" />
                                                <span class="absolute top-2 left-2 px-2 py-0.5 bg-red-600 text-[10px] font-bold rounded animate-pulse">LIVE</span>
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
                            containerUsers.innerHTML = '<p class="text-sm text-slate-500 bg-slate-900 border border-slate-800 p-4 rounded-xl">Nenhuma imagem armazenada.</p>';
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
                                    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4"> \`;

                            if (fotos.length === 0) {
                                htmlGaleria += '<p class="text-xs text-slate-500 col-span-full">Pasta vazia.</p>';
                            } else {
                                [...fotos].reverse().forEach(fotoNome => {
                                    htmlGaleria += \`
                                        <div class="bg-slate-900 border border-slate-800/80 rounded-xl overflow-hidden group hover:border-slate-700 transition shadow-md">
                                            <div class="aspect-video bg-slate-950 overflow-hidden relative">
                                                <img src="/uploads/\${userId}/\${fotoNome}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" alt="Captura IoT" />
                                            </div>
                                            <div class="p-2.5 text-[10px] text-slate-400 bg-slate-900/90 font-mono truncate">\${fotoNome}</div>
                                        </div> \`;
                                });
                            }
                            htmlGaleria += \`</div></div>\`;
                            containerUsers.innerHTML += htmlGaleria;
                        });
                    })
                    .catch(err => console.error(err));
            }
            carregarDados();
            setInterval(carregarDados, 15000);
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => { console.log(`🚀 Servidor OmniGuardian Online na porta ${PORT}!`); });
