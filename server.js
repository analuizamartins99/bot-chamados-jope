require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const { Resend } = require('resend');
const cors   = require('cors');
const path   = require('path');

const app    = express();
const PORT   = process.env.PORT || 3000;
const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_DESTINO = process.env.EMAIL_DESTINO || 'ana.martins@jopeisb.com.br';

// ─── Upload em memória (fotos ficam no e-mail como anexo) ─────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas JPG e PNG são permitidos'));
  }
});

// ─── Classificação N1 ─────────────────────────────────────────────────────────
const KEYWORDS_N1 = {
  'Água / Hidráulico': [
    'vazamento','vazando','pingando','entupido','entupimento','nao escoa',
    'nao sai agua','falta dagua','falta de agua','sem agua','cano','caixa dagua',
    'bomba','goteira','infiltracao','molhando','umido','escorrendo','registro','torneira','vaso','descarga'
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
    'praga','infestacao','rato','ratazana','barata','cupim','formiga','inseto','bicho','roedor'
  ],
};

const SLA_POR_TIPO = {
  'Hidráulica': 12, 'Aquecimento Solar': 18, 'Elétrica': 12,
  'Segurança / CFTV': 18, 'Segurança / Alarme': 18,
  'Predial / Acabamento': 24, 'Predial / Serralheria': 18,
  'Predial / Telhado': 18, 'Predial / Mobiliário': 24,
  'Predial / Toldo': 24, 'TI / Dados': 12,
  'Plataforma Elevatória': 12, 'Controle de Pragas': 24,
};

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
}

function sugerirN1(descricao) {
  const texto = norm(descricao);
  const scores = Object.entries(KEYWORDS_N1).map(([grupo, palavras]) => ({
    grupo, hits: palavras.filter(p => texto.includes(norm(p))).length
  })).filter(x => x.hits > 0).sort((a, b) => b.hits - a.hits);
  if (!scores.length) return null;
  const total = scores.reduce((s, x) => s + x.hits, 0);
  return { grupo: scores[0].grupo, confianca: Math.round(scores[0].hits / total * 100) };
}

// ─── Formatar e-mail do chamado ───────────────────────────────────────────────
function gerarEmailHTML(c) {
  const urgenciaCor = { Baixo: '#4caf50', Médio: '#ff9800', Alto: '#f44336', Crítico: '#7b1fa2' };
  const cor = urgenciaCor[c.urgencia] || '#333';
  const sla = SLA_POR_TIPO[c.tipoOS] || 24;

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"/></head>
<body style="font-family:Arial,sans-serif;background:#f0f2f5;padding:24px;margin:0">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">

    <div style="background:#1a56a0;padding:20px 24px;color:#fff">
      <h2 style="margin:0;font-size:18px">🔧 Novo Chamado de Manutenção</h2>
      <p style="margin:4px 0 0;opacity:.85;font-size:13px">Jope ISB — Sistema de Chamados</p>
    </div>

    <div style="padding:24px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;width:40%">Número do chamado</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;font-weight:700;color:#1a56a0">${c.id}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">Data / Hora</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee">${c.dataAbertura}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">Perfil</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee">${c.perfil === 'tecnico' ? 'Técnico / Equipe' : 'Funcionário da escola'}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">Solicitante</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee">${c.solicitanteNome}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">Contato</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee">${c.contato}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">Unidade</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee">${c.tipoEscola || ''} ${c.escola}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">Local</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee">${c.local}${c.andar ? ' — ' + c.andar : ''}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">Tipo OS</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee"><strong>${c.tipoOS}</strong></td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">Equipe</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee">${c.equipe || '—'}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">Urgência</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee">
            <span style="background:${cor};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700">${c.urgencia}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#666">SLA</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee">${sla}h após abertura</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#666;vertical-align:top">Descrição</td>
          <td style="padding:10px 0">${c.descricao}</td>
        </tr>
        ${c.equipamento ? `<tr><td style="padding:10px 0;border-top:1px solid #eee;color:#666">Equipamento</td><td style="padding:10px 0;border-top:1px solid #eee">${c.equipamento}</td></tr>` : ''}
        ${c.numPatrimonio ? `<tr><td style="padding:10px 0;border-top:1px solid #eee;color:#666">Nº Patrimônio</td><td style="padding:10px 0;border-top:1px solid #eee">${c.numPatrimonio}</td></tr>` : ''}
        ${c.materiais ? `<tr><td style="padding:10px 0;border-top:1px solid #eee;color:#666">Materiais</td><td style="padding:10px 0;border-top:1px solid #eee">${c.materiais}</td></tr>` : ''}
        ${c.gate ? `<tr><td colspan="2" style="padding:12px;background:#fff3e0;border-radius:8px;margin-top:12px;font-size:13px">⚠️ <strong>Gate de aprovação ativado</strong> — este chamado requer aprovação do Supervisor antes do despacho.</td></tr>` : ''}
      </table>
    </div>

    <div style="background:#f8f9fa;padding:14px 24px;font-size:12px;color:#888;text-align:center">
      Chamado gerado automaticamente pelo Bot de Manutenção — Jope ISB
    </div>
  </div>
</body>
</html>`;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Endpoints ────────────────────────────────────────────────────────────────

app.post('/classificar', (req, res) => {
  const { descricao } = req.body;
  if (!descricao || descricao.trim().length < 3) return res.status(400).json({ erro: 'Texto muito curto.' });
  res.json(sugerirN1(descricao) || { grupo: null });
});

app.post('/chamado', upload.array('fotos', 5), async (req, res) => {
  try {
    const {
      perfil, solicitanteNome, matricula, contato, tipoEscola, escola,
      local, andar, tipoOS, equipe, urgencia, descricao,
      equipamento, numPatrimonio, osOrigem, materiais
    } = req.body;

    // Validação de campos obrigatórios
    const obrigatorios = { perfil, solicitanteNome, contato, escola, local, tipoOS, urgencia, descricao };
    for (const [campo, valor] of Object.entries(obrigatorios)) {
      if (!valor?.trim()) return res.status(400).json({ erro: `Campo obrigatório ausente: ${campo}` });
    }

    const minChars = perfil === 'tecnico' ? 15 : 10;
    if (descricao.trim().length < minChars) {
      return res.status(400).json({ erro: `Descrição deve ter ao menos ${minChars} caracteres.` });
    }

    if (urgencia === 'Crítico' && perfil !== 'tecnico') {
      return res.status(400).json({ erro: 'Urgência Crítico disponível apenas para técnicos.' });
    }

    const ano  = new Date().getFullYear();
    const seq  = String(Date.now()).slice(-5);
    const id   = `JOP-${ano}-${seq}`;
    const dataAbertura = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const gate = ['Plataforma Elevatória', 'Controle de Pragas'].includes(tipoOS);
    const sla  = SLA_POR_TIPO[tipoOS] || 24;

    const chamado = {
      id, dataAbertura, perfil, solicitanteNome,
      matricula: matricula || '', contato, tipoEscola: tipoEscola || '',
      escola, local, andar: andar || '', tipoOS, equipe: equipe || '',
      urgencia, descricao, equipamento: equipamento || '',
      numPatrimonio: numPatrimonio || '', osOrigem: osOrigem || '',
      materiais: materiais || '', gate, sla
    };

    // Monta anexos de foto
    const attachments = (req.files || []).map((f, i) => ({
      filename: `foto${i + 1}.${f.mimetype === 'image/jpeg' ? 'jpg' : 'png'}`,
      content: f.buffer.toString('base64'),
    }));

    // Envia e-mail
    await resend.emails.send({
      from:    'Bot Manutenção <onboarding@resend.dev>',
      to:      EMAIL_DESTINO,
      subject: `[${urgencia.toUpperCase()}] Chamado ${id} — ${tipoOS} | ${escola}`,
      html:    gerarEmailHTML(chamado),
      attachments,
    });

    res.json({ sucesso: true, id, gate, tipoOS });
  } catch (err) {
    console.error('Erro ao registrar chamado:', err.message);
    res.status(500).json({ erro: 'Falha ao registrar chamado. Tente novamente.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Bot rodando em http://localhost:${PORT}`));
