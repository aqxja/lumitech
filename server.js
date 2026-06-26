const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000; 

app.use(express.json());

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'dispositivos.json');

app.use('/uploads', express.static(UPLOADS_DIR));

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

let cacheDispositivosMemoria = [];

function carregarBanco() {
    try {
        if (!fs.existsSync(DB_FILE) || fs.readFileSync(DB_FILE, 'utf8').trim() === '') {
            fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
            return [];
        }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

cacheDispositivosMemoria = carregarBanco();

const streamStatus = {};  
const liveClients = {};   

function registrarHardwarePorIdDeContingencia(mac, userIdOpcional = 'USR-8742') {
    if (!mac || mac.trim() === "") return;
    try {
        const existe = cacheDispositivosMemoria.some(item => item.mac_address === mac);
        if (!existe) {
            const deviceInfo = { 
                user_id: userIdOpcional, 
                mac_address: mac, 
                device_model: "XIAO ESP32S3 OmniGuardian (Auto-Conectado)", 
                last_seen: new Date().toISOString() 
            };
            cacheDispositivosMemoria.push(deviceInfo);
            fs.writeFileSync(DB_FILE, JSON.stringify(cacheDispositivosMemoria, null, 2));
            console.log(`\n🤖 [AUTO-CONEXÃO] Câmera ${mac} indexada com sucesso.`);
            
            const pastaDoUsuario = path.join(UPLOADS_DIR, userIdOpcional);
            if (!fs.existsSync(pastaDoUsuario)) {
                fs.mkdirSync(pastaDoUsuario, { recursive: true });
            }
        }
    } catch (e) {
        console.error("Falha ao registrar hardware dinamicamente:", e);
    }
}

app.get('/api/iot/stream-status', (req, res) => {
    const mac = req.query.mac;
    registrarHardwarePorIdDeContingencia(mac); 
    res.json({ stream: !!streamStatus[mac] });
});

app.post('/api/iot/toggle-stream', (req, res) => {
    const { mac_address, action } = req.body;
    if (action === 'start') {
        streamStatus[mac_address] = true;
        console.log(`\n🎥 [STREAM] Transmissão de vídeo iniciada para: ${mac_address}`);
    } else {
        streamStatus[mac_address] = false;
        console.log(`\n🛑 [STREAM] Transmissão de vídeo encerrada para: ${mac_address}`);
        if (liveClients[mac_address]) {
            liveClients[mac_address].forEach(c => { try { c.end(); } catch(e){} });
            liveClients[mac_address] = [];
        }
    }
    res.json({ status: "success", stream: streamStatus[mac_address] });
});

app.post('/api/iot/stream-frame', express.raw({ type: 'image/jpeg', limit: '500kb' }), (req, res) => {
    const macAddress = req.headers['x-mac-address'];
    if (!macAddress || !req.body || req.body.length === 0) {
        return res.send('STOP');
    }

    registrarHardwarePorIdDeContingencia(macAddress); 

    if (!streamStatus[macAddress] || !liveClients[macAddress] || liveClients[macAddress].length === 0) {
        streamStatus[macAddress] = false;
        return res.send('STOP');
    }

    const frame = req.body;
    liveClients[macAddress].forEach(clientRes => {
        try {
            clientRes.write(`--frame\r\n`);
            clientRes.write(`Content-Type: image/jpeg\r\n`);
            clientRes.write(`Content-Length: ${frame.length}\r\n\r\n`);
            clientRes.write(frame);
            clientRes.write(`\r\n`);
        } catch(e) {}
    });

    res.send('START'); 
});

app.get('/api/iot/live/:mac', (req, res) => {
    const mac = req.params.mac;
    
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); 

    if (!liveClients[mac]) liveClients[mac] = [];
    liveClients[mac].push(res);

    req.on('close', () => {
        liveClients[mac] = liveClients[mac].filter(c => c !== res);
        if (liveClients[mac].length === 0) {
            streamStatus[mac] = false;
            console.log(`🛑 [STREAM] Sem espectadores na página. Desligando streaming do MAC: ${mac}`);
        }
    });
});

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
    if (!mac_address) return res.status(400).send('MAC Address ausente.');
    
    const finalUserId = user_id || 'USR-8742';
    try {
        const deviceIndex = cacheDispositivosMemoria.findIndex(item => item.mac_address === mac_address);
        const deviceInfo = { user_id: finalUserId, mac_address, device_model: device_model || "ESP32-CAM OmniGuardian", last_seen: new Date().toISOString() };
        
        if (deviceIndex >= 0) cacheDispositivosMemoria[deviceIndex] = deviceInfo; else cacheDispositivosMemoria.push(deviceInfo);
        fs.writeFileSync(DB_FILE, JSON.stringify(cacheDispositivosMemoria, null, 2));
        console.log(`\n📲 [API] Dispositivo Registrado: Usuário ${finalUserId} -> Câmera ${mac_address}`);

        const pastaDoUsuario = path.join(UPLOADS_DIR, finalUserId);
        if (!fs.existsSync(pastaDoUsuario)) {
            fs.mkdirSync(pastaDoUsuario, { recursive: true });
        }

        res.status(200).json({ status: "success" });
    } catch (err) { 
        console.error(err);
        res.status(500).send('Erro no registro.'); 
    }
});

app.post('/api/iot/lighttrap/', upload.single('image'), (req, res) => {
    const macAddress = req.body.mac_address;
    const file = req.file;
    if (!file) return res.status(400).send('Imagem ausente.');
    
    let userId = 'USR-8742'; 
    registrarHardwarePorIdDeContingencia(macAddress, userId); 

    const linkCorrespondente = cacheDispositivosMemoria.find(item => item.mac_address === macAddress);
    if (linkCorrespondente) {
        userId = linkCorrespondente.user_id;
    }
    
    const pastaDoUsuario = path.join(UPLOADS_DIR, userId);
    if (!fs.existsSync(pastaDoUsuario)) fs.mkdirSync(pastaDoUsuario, { recursive: true });
    fs.rename(file.path, path.join(pastaDoUsuario, file.filename), (err) => {
        if (err) return res.status(500).send('Erro interno.');
        res.status(200).send('OK');
    });
});

app.get('/api/iot/overview', (req, res) => {
    try {
        let estruturaPastas = {};
        if (fs.existsSync(UPLOADS_DIR)) {
            fs.readdirSync(UPLOADS_DIR).forEach(usuario => {
                const caminhoUsuario = path.join(UPLOADS_DIR, usuario);
                if (fs.statSync(caminhoUsuario).isDirectory()) estruturaPastas[usuario] = fs.readdirSync(caminhoUsuario);
            });
        }
        res.status(200).json({ dispositivos_registrados: cacheDispositivosMemoria, arquivos_armazenados: estruturaPastas });
    } catch (err) { res.status(500).json({ erro: "Erro ao gerar relatório." }); }
});

app.get('/dashboard', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>LumiTrap - Central Unificada</title>
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
                        <p class="text-xs text-slate-400">Painel Geral de Dispositivos</p>
                    </div>
                </div>
                <button onclick="carregarDados()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-sm font-semibold rounded-lg transition shadow-lg shadow-blue-600/20 active:scale-95">🔄 Atualizar Central</button>
            </div>
        </header>

        <main class="max-w-7xl mx-auto px-4 py-8">
            <div class="flex items-center gap-2 mb-6">
                <span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                <h2 class="text-lg font-bold text-slate-300">Sua Rede OmniGuardian</h2>
            </div>
            
            <div id="central-dispositivos" class="flex flex-col gap-8">
                <p class="text-sm text-slate-500 bg-slate-900 border border-slate-800 p-4 rounded-xl">Indexando barramento de hardware...</p>
            </div>
        </main>

        <script>
            function toggleLiveStream(mac) {
                var container = document.getElementById('video-container-' + mac.replace(/:/g, ''));
                var img = document.getElementById('video-feed-' + mac.replace(/:/g, ''));
                var btn = document.getElementById('btn-stream-' + mac.replace(/:/g, ''));
                
                if (container.classList.contains('hidden')) {
                    fetch('/api/iot/toggle-stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mac_address: mac, action: 'start' })
                    })
                    .then(function(res) { return res.json(); })
                    .then(function(data) {
                        container.classList.remove('hidden');
                        
                        // ✅ CORREÇÃO: Cache-Buster com carimbo de milissegundo (?t=...) 
                        // Força o browser a resetar e ignorar streams velhas ou rompidas da memória cache
                        img.src = '/api/iot/live/' + mac + '?t=' + Date.now();
                        
                        btn.innerHTML = '🛑 Encerrar Transmissão';
                        btn.classList.replace('bg-indigo-600', 'bg-red-600');
                        btn.classList.replace('hover:bg-indigo-500', 'hover:bg-red-500');
                    });
                } else {
                    fetch('/api/iot/toggle-stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mac_address: mac, action: 'stop' })
                    })
                    .then(function(res) { return res.json(); })
                    .then(function(data) {
                        container.classList.add('hidden');
                        img.src = '';
                        btn.innerHTML = '🎥 Abrir Transmissão Ao Vivo';
                        btn.classList.replace('bg-red-600', 'bg-indigo-600');
                        btn.classList.replace('hover:bg-red-500', 'hover:bg-indigo-500');
                    });
                }
            }

            function forcarRegistroManual() {
                var macInput = document.getElementById('debug-mac');
                if (!macInput || !macInput.value.trim()) return alert('Insira um MAC válido!');
                
                fetch('/api/iot/register-device', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mac_address: macInput.value.trim().toUpperCase(), user_id: 'USR-8742' })
                })
                .then(function() { carregarDados(); });
            }

            function carregarDados() {
                fetch('/api/iot/overview')
                    .then(function(res) { return res.json(); })
                    .then(function(data) {
                        var central = document.getElementById('central-dispositivos');
                        central.innerHTML = '';
                        
                        if (!data.dispositivos_registrados || data.dispositivos_registrados.length === 0) {
                            central.innerHTML = [
                                '<div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl max-w-xl mx-auto text-center space-y-4">',
                                '    <p class="text-sm text-slate-400">Nenhuma câmera ativa em memória (o Render pode ter reiniciado).</p>',
                                '    <div class="border-t border-slate-800 pt-4 space-y-3">',
                                '        <p class="text-xs text-slate-500">💡 Ferramenta de Debug: Force a visualização digitando o MAC da sua câmara:</p>',
                                '        <div class="flex gap-2">',
                                '            <input id="debug-mac" type="text" placeholder="Ex: 24:0A:C4:XX:XX:XX" class="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs w-full text-slate-200 uppercase font-mono focus:outline-none focus:border-blue-500">',
                                '            <button onclick="forcarRegistroManual()" class="bg-blue-600 hover:bg-blue-500 text-xs font-bold px-4 py-2 rounded-xl transition whitespace-nowrap">Conectar MAC</button>',
                                '        </div>',
                                '    </div>',
                                '</div>'
                            ].join('');
                            return;
                        }

                        data.dispositivos_registrados.forEach(function(disp) {
                            var dataFormatada = new Date(disp.last_seen).toLocaleString('pt-BR');
                            var macIdSanitizado = disp.mac_address.replace(/:/g, '');
                            var fotosUsuario = data.arquivos_armazenados[disp.user_id] || [];
                            
                            var htmlFotos = '';
                            if (fotosUsuario.length === 0) {
                                htmlFotos = '<p class="text-xs text-slate-500 bg-slate-950/60 p-4 rounded-xl border border-slate-800/40">Nenhuma captura armazenada para este usuário.</p>';
                            } else {
                                htmlFotos = '<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">';
                                var fotosInversas = [].concat(fotosUsuario).reverse();
                                fotosInversas.forEach(function(fotoNome) {
                                    htmlFotos += [
                                        '<div class="bg-slate-950 border border-slate-800/80 rounded-xl overflow-hidden group hover:border-slate-700 transition shadow-inner">',
                                        '    <div class="aspect-video bg-black overflow-hidden relative">',
                                        '        <img src="/uploads/' + disp.user_id + '/' + fotoNome + '" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" />',
                                        '    </div>',
                                        '    <div class="p-2 text-[10px] text-slate-400 font-mono truncate">' + fotoNome + '</div>',
                                        '</div>'
                                    ].join('');
                                });
                                htmlFotos += '</div>';
                            }

                            var cardHtml = [
                                '<div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-2xl space-y-6">',
                                '    <div class="flex justify-between items-center border-b border-slate-800 pb-4">',
                                '        <div>',
                                '            <h3 class="text-lg font-bold text-slate-100 flex items-center gap-2">📷 ID Usuário: ' + disp.user_id + '</h3>',
                                '            <p class="text-xs text-slate-400 mt-1">Modelo: <span class="text-blue-400 font-medium">' + disp.device_model + '</span> | MAC: <span class="font-mono text-slate-300">' + disp.mac_address + '</span></p>',
                                '        </div>',
                                '        <div class="text-right text-xs">',
                                '            <span class="text-emerald-400 font-semibold flex items-center justify-end gap-1">● Dispositivo Online</span>',
                                '            <p class="text-[10px] text-slate-500 mt-1">Sinalizado em: ' + dataFormatada + '</p>',
                                '        </div>',
                                '    </div>',
                                '    ',
                                '    <div class="space-y-3">',
                                '        <h4 class="text-sm font-semibold text-slate-300 flex items-center gap-1.5">🎬 Transmissão de Vídeo Feed</h4>',
                                '        <button data-mac="' + disp.mac_address + '" id="btn-stream-' + macIdSanitizado + '" class="btn-toggle-stream px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-bold rounded-xl transition active:scale-95 shadow-md flex items-center gap-1.5">',
                                '            🎥 Abrir Transmissão Ao Vivo',
                                '        </button>',
                                '        <div id="video-container-' + macIdSanitizado + '" class="hidden rounded-xl overflow-hidden border border-slate-800 bg-black aspect-video max-w-2xl relative flex items-center justify-center mx-auto shadow-2xl">',
                                '            <img id="video-feed-' + macIdSanitizado + '" class="w-full h-full object-contain" src="" alt="Live feed" />',
                                '            <span class="absolute top-3 left-3 px-2 py-0.5 bg-red-600 text-[10px] font-bold rounded animate-pulse">STREAM ATIVO</span>',
                                '        </div>',
                                '    </div>',
                                '    ',
                                '    <div class="pt-4 border-t border-slate-800/60 space-y-3">',
                                '        <h4 class="text-sm font-semibold text-slate-300">📁 Pasta de Armazenamento Coletado (' + disp.user_id + ')</h4>',
                                '        ' + htmlFotos,
                                '    </div>',
                                '</div>'
                            ].join('');

                            central.innerHTML += cardHtml;
                        });
                    })
                    .catch(function(err) { console.error("Erro ao carregar dados do painel:", err); });
            }

            document.addEventListener('click', function(e) {
                if (e.target && e.target.classList.contains('btn-toggle-stream')) {
                    var macAddress = e.target.getAttribute('data-mac');
                    toggleLiveStream(macAddress);
                }
            });

            carregarDados();
            setInterval(carregarDados, 10000);
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => { console.log(`🚀 Servidor LumiTrap Online na porta ${PORT}!`); });
