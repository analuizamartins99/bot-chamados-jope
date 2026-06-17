require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Upload ───────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas JPG e PNG são permitidos'));
  }
});

// ─── Classificação N1 — palavras-chave derivadas de 13.680 chamados históricos ─
// Fonte: Classificacao_Webchat_Bot_v1.docx — Seção 4
const KEYWORDS_N1 = {
  'Água / Hidráulico': [
    'vazamento','vazando','pingando','entupido','entupimento','nao escoa',
    'nao sai agua','falta dagua','falta de agua','sem agua','cano','caixa dagua',
    'bomba','goteira','infiltracao','molhando','umido','escorrendo','registro',
    'torneira','vaso','descarga'
  ],
  'Não funciona / Elétrico': [
    'nao funciona','nao liga','sem luz','queimou','queima','mau contato','curto',
    'desligou','disjuntor','falta energia','sem energia','travado','tomada',
    'interruptor','lampada','luminaria','camera','cftv','alarme','elevador',
    'plataforma elevatoria','computador','projetor','internet','rede'
  ],
  'Quebrado / Danificado': [
    'quebrado','quebrou','quebra','solto','caiu','rachado','trincado','danificado',
    'desgastado','desgaste','desprendeu','nao abre','nao fecha','emperrado',
    'desalinhado','deformado','corroido','vidro','porta','janela','grade','piso',
    'parede','revestimento','carteira','mesa','lousa','movel','toldo'
  ],
  'Pragas / Infestação': [
    'praga','infestacao','rato','ratazana','barata','cupim','formiga',
    'inseto','bicho','roedor'
  ],
};

// SLA em horas por tipo de OS (Seção 6 do doc de classificação)
const SLA_POR_TIPO = {
  'Hidráulica':           12,
  'Aquecimento Solar':    18,
  'Elétrica':             12,
  'Segurança / CFTV':     18,
  'Segurança / Alarme':   18,
  'Predial / Acabamento': 24,
  'Predial / Serralheria':18,
  'Predial / Telhado':    18,
  'Predial / Mobiliário': 24,
  'Predial / Toldo':      24,
  'TI / Dados':           12,
  'Plataforma Elevatória':12,
  'Controle de Pragas':   24,
};

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Sugestão de N1 com base em texto livre (não compulsória — usuário confirma)
function sugerirN1(descricao) {
  const texto = norm(descricao);
  const scores = Object.entries(KEYWORDS_N1).map(([grupo, palavras]) => {
    const hits = palavras.filter(p => texto.includes(norm(p))).length;
    return { grupo, hits };
  }).filter(x => x.hits > 0).sort((a, b) => b.hits - a.hits);

  if (scores.length === 0) return null;
  const total = scores.reduce((s, x) => s + x.hits, 0);
  const principal = scores[0];
  const confianca = Math.round((principal.hits / total) * 100);
  const segundo = scores[1] ? { grupo: scores[1].grupo, confianca: 100 - confianca } : null;
  return { grupo: principal.grupo, confianca, segundo };
}

// ─── Google Auth ──────────────────────────────────────────────────────────────
function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
  );
}

// ─── Upload de fotos para Google Drive ───────────────────────────────────────
async function uploadFotos(auth, files, idChamado) {
  if (!files || files.length === 0) return [];
  const drive = google.drive({ version: 'v3', auth });
  const urls = [];
  for (const [i, file] of files.entries()) {
    const ext = file.mimetype === 'image/jpeg' ? 'jpg' : 'png';
    const { data } = await drive.files.create({
      requestBody: {
        name: `${idChamado}_foto${i + 1}.${ext}`,
        mimeType: file.mimetype
      },
      media: { mimeType: file.mimetype, body: Readable.from(file.buffer) },
      fields: 'id, webViewLink',
    });
    await drive.permissions.create({
      fileId: data.id,
      requestBody: { role: 'reader', type: 'anyone' }
    });
    urls.push(data.webViewLink);
  }
  return urls;
}

// ─── Google Sheets ────────────────────────────────────────────────────────────
const CABECALHO = [
  'ID Chamado', 'Data Abertura', 'Perfil Usuário', 'Solicitante', 'Matrícula',
  'Contato', 'Escola', 'Local/Área', 'Andar', 'Tipo OS', 'Equipe', 'Urgência',
  'Descrição', 'Equipamento', 'Nº Patrimônio', 'OS Origem', 'Materiais',
  'Fotos', 'SLA (h)', 'Gate Requerido', 'Status', 'Equipe Atribuída',
  'Aprovado Por', 'Data Decisão Gate', 'Resolução', 'Status Final',
  'Data Fechamento', 'SLA Alertas'
];

async function garantirCabecalho(sheets, sheetId) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: 'Chamados!A1'
  });
  if (!data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Chamados!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [CABECALHO] }
    });
  }
}

async function gravarChamado(auth, c) {
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetId = process.env.GOOGLE_SHEET_ID;
  await garantirCabecalho(sheets, sheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Chamados!A:Z',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        c.id, c.dataAbertura, c.perfil, c.solicitanteNome, c.matricula,
        c.contato, c.escola, c.local, c.andar || '',
        c.tipoOS, c.equipe || '', c.urgencia, c.descricao,
        c.equipamento || '', c.numPatrimonio || '', c.osOrigem || '', c.materiais || '',
        (c.fotos || []).join(' | '),
        c.slaHoras || 24,
        c.gate ? 'Sim' : 'Não',
        c.gate ? 'Aguardando Gate' : 'Aberto',
        c.gate ? 'Terceiros (aguardando gate)' : 'A despachar',
        '', '', '', '', '', ''
      ]]
    }
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Endpoints ────────────────────────────────────────────────────────────────

// Sugestão de N1 por texto livre (retorna grupo sugerido, não compulsório)
app.post('/classificar', (req, res) => {
  const { descricao } = req.body;
  if (!descricao || descricao.trim().length < 3) {
    return res.status(400).json({ erro: 'Texto muito curto.' });
  }
  const sugestao = sugerirN1(descricao);
  res.json(sugestao || { grupo: null });
});

// Abertura de chamado
app.post('/chamado', upload.array('fotos', 5), async (req, res) => {
  try {
    const {
      perfil, solicitanteNome, matricula, contato, escola, local, andar,
      tipoOS, urgencia, descricao, equipamento, numPatrimonio, osOrigem, materiais
    } = req.body;

    // Validação de campos obrigatórios
    const obrigatorios = { perfil, solicitanteNome, contato, escola, local, tipoOS, urgencia, descricao };
    for (const [campo, valor] of Object.entries(obrigatorios)) {
      if (!valor || !String(valor).trim()) {
        return res.status(400).json({ erro: `Campo obrigatório ausente: ${campo}` });
      }
    }

    // Validação de tamanho mínimo da descrição
    const minChars = perfil === 'tecnico' ? 15 : 10;
    if (descricao.trim().length < minChars) {
      return res.status(400).json({ erro: `Descrição deve ter ao menos ${minChars} caracteres.` });
    }

    // Validação de urgência Crítico só para técnico
    if (urgencia === 'Crítico' && perfil !== 'tecnico') {
      return res.status(400).json({ erro: 'Urgência Crítico disponível apenas para técnicos.' });
    }

    // Limite de fotos por perfil
    const maxFotos = perfil === 'tecnico' ? 5 : 3;
    if (req.files && req.files.length > maxFotos) {
      return res.status(400).json({ erro: `Máximo de ${maxFotos} fotos para este perfil.` });
    }

    // Gera ID no formato JOP-YYYY-NNNNN
    const ano = new Date().getFullYear();
    const seq = String(Date.now()).slice(-5);
    const id = `JOP-${ano}-${seq}`;
    const dataAbertura = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const auth = getAuth();
    const fotos = await uploadFotos(auth, req.files || [], id);

    // Gate obrigatório para Plataforma Elevatória e Controle de Pragas (Seção 5 do doc classificação)
    const gate = ['Plataforma Elevatória', 'Controle de Pragas'].includes(tipoOS);

    // SLA em horas conforme tipo de OS
    const slaHoras = SLA_POR_TIPO[tipoOS] || 24;

    await gravarChamado(auth, {
      id, dataAbertura, perfil, solicitanteNome, matricula: matricula || '',
      contato, escola, local, andar, tipoOS, urgencia, descricao,
      equipamento, numPatrimonio, osOrigem, materiais, fotos, gate, slaHoras
    });

    res.json({ sucesso: true, id, gate, tipoOS });
  } catch (err) {
    console.error('Erro ao registrar chamado:', err.message);
    res.status(500).json({ erro: 'Falha ao registrar chamado. Tente novamente.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Bot de chamados rodando em http://localhost:${PORT}`);
});
