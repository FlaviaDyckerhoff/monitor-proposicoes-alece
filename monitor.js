const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO   = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA     = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO  = 'estado.json';

const VDOC_AJAX = 'https://vdocleg.al.ce.gov.br/vdoc_leg/ajax/ajaxLocalizarProcessos.jsp';
const VDOC_HOME = 'https://vdocleg.al.ce.gov.br/vdoc_leg/consultaExterna/localizarProcessos.jsp';

const PAGINAS_POR_RUN = 3;

// ─── Estado ──────────────────────────────────────────────────────────────────

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: null };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

// ─── Sessão ───────────────────────────────────────────────────────────────────

async function obterSessao() {
  console.log('   Obtendo sessao do V-Doc...');

  const response = await fetch(VDOC_HOME, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    redirect: 'follow',
  });

  // Extrai JSESSIONID do header Set-Cookie
  const cookies = response.headers.get('set-cookie') || '';
  const match = cookies.match(/JSESSIONID=([A-F0-9]+)/i);

  if (!match) {
    console.error('   Nao foi possivel obter JSESSIONID. Cookies recebidos:', cookies.substring(0, 200));
    // Tenta continuar sem sessao — pode funcionar em alguns casos
    return null;
  }

  const jsessionid = match[1];
  console.log('   JSESSIONID obtido: ' + jsessionid.substring(0, 8) + '...');
  return jsessionid;
}

// ─── XML Parser mínimo ────────────────────────────────────────────────────────

function extrairTag(xml, tag) {
  const re = new RegExp('<' + tag + '>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/' + tag + '>', 'i');
  const m = xml.match(re);
  if (!m) return null;
  return (m[1] !== undefined ? m[1] : m[2] || '').trim();
}

function parsearRegistros(xml) {
  const registros = [];
  const blocos = xml.match(/<registros>[\s\S]*?<\/registros>/g) || [];
  for (const bloco of blocos) {
    registros.push({
      id:      extrairTag(bloco, 'codigoProcesso'),
      numero:  extrairTag(bloco, 'numeroProcesso'),
      ano:     extrairTag(bloco, 'anoProcesso'),
      tipo:    extrairTag(bloco, 'assunto'),
      ementa:  extrairTag(bloco, 'ementa'),
      autor:   extrairTag(bloco, 'autor'),
      lotacao: extrairTag(bloco, 'lotacao'),
    });
  }
  return registros;
}

// ─── Busca ────────────────────────────────────────────────────────────────────

async function buscarPagina(pagina, jsessionid) {
  const params = new URLSearchParams({
    comando:                         'exibirRegistrosLocalizarProcessos',
    numeroProcesso:                  '',
    nomeParte:                       '',
    dataDe:                          '',
    dataAte:                         '',
    codigoCategoriaAssunto:          '',
    codigoFase:                      '',
    codigoSituacao:                  '',
    codigoLotacaoSelecionada:        '0',
    codigoAssuntoSelecionado:        '',
    codigoClassificacaoPCTT:         '0',
    ordenacaoAtualLocalizarProcesso: 'undefined',
    observacoesProcesso:             '',
    limite:                          '20',
    pagina:                          String(pagina),
  });

  const url = VDOC_AJAX + '?' + params.toString();
  console.log('   Pagina ' + pagina + '...');

  const headers = {
    'Accept':          '*/*',
    'Referer':         VDOC_HOME,
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'pt-BR,pt;q=0.9',
  };

  if (jsessionid) {
    headers['Cookie'] = 'JSESSIONID=' + jsessionid;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    console.error('   Erro HTTP ' + response.status);
    const txt = await response.text().catch(() => '');
    console.error('   Resposta:', txt.substring(0, 300));
    return { registros: [], fim: true };
  }

  const xml = await response.text();

  if (!xml || xml.trim() === '') {
    console.error('   Resposta vazia (body em branco)');
    return { registros: [], fim: true };
  }

  if (!xml.includes('<root>')) {
    console.error('   Resposta inesperada (nao e XML do V-Doc):');
    console.error('  ', xml.substring(0, 400));
    return { registros: [], fim: true };
  }

  const registros    = parsearRegistros(xml);
  const ultimaPagina = parseInt(extrairTag(xml, 'ultimaPagina') || '0');
  const total        = parseInt(extrairTag(xml, 'total')        || '0');

  if (pagina === 1) {
    console.log('   Total na base: ' + total + ' | ultima pagina: ' + ultimaPagina);
  }

  return {
    registros,
    fim: pagina >= ultimaPagina || registros.length === 0,
  };
}

async function buscarProposicoes() {
  console.log('Consultando V-Doc ALECE...');

  const jsessionid = await obterSessao();
  // Pequena pausa após obter sessão — dá tempo do servidor registrar
  await new Promise(r => setTimeout(r, 800));

  const todas = [];

  for (let p = 1; p <= PAGINAS_POR_RUN; p++) {
    const { registros, fim } = await buscarPagina(p, jsessionid);
    todas.push(...registros);
    if (fim) break;
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(todas.length + ' proposicoes obtidas neste run');
  return todas;
}

// ─── Normalização ─────────────────────────────────────────────────────────────

function normalizarProposicao(p) {
  const numero = (p.numero || '').replace(/^0+/, '') || '-';
  const tipo   = (p.tipo   || 'OUTROS').trim().toUpperCase();
  const ementa = (!p.ementa || p.ementa.trim() === '.')
    ? '(ementa nao disponivel)'
    : p.ementa.substring(0, 300);

  return {
    id:     String(p.id),
    tipo,
    numero,
    ano:    p.ano || String(new Date().getFullYear()),
    autor:  (p.autor || '-').trim(),
    ementa,
  };
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    if (!porTipo[p.tipo]) porTipo[p.tipo] = [];
    porTipo[p.tipo].push(p);
  });

  const COR = '#0a4d8c';

  const blocos = Object.keys(porTipo).sort().map(tipo => {
    const header = '<tr><td colspan="3" style="padding:10px 8px 4px;background:#e8f0fb;font-weight:bold;color:' + COR + ';font-size:13px;border-top:2px solid ' + COR + ';border-bottom:1px solid #c9d9f0">' + tipo + ' &mdash; ' + porTipo[tipo].length + ' proposicao(oes)</td></tr>';
    const rows = porTipo[tipo].map(p =>
      '<tr>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap;font-size:13px;vertical-align:top"><strong style="color:' + COR + '">' + p.numero + '/' + p.ano + '</strong></td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee;color:#555;font-size:12px;white-space:nowrap;vertical-align:top">' + p.autor + '</td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top">' + p.ementa + '</td>' +
      '</tr>'
    ).join('');
    return header + rows;
  }).join('');

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">' +
    '<div style="background:' + COR + ';padding:16px 20px;border-radius:6px 6px 0 0">' +
    '<h2 style="color:white;margin:0;font-size:18px">&#127963;&#65039; ALECE &mdash; ' + novas.length + ' nova(s) proposicao(oes)</h2>' +
    '<p style="color:#cde;margin:4px 0 0;font-size:13px">Monitoramento automatico &mdash; ' + new Date().toLocaleString('pt-BR') + '</p>' +
    '</div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid #c9d9f0;border-top:none">' +
    '<thead><tr style="background:#1a5fa8;color:white">' +
    '<th style="padding:10px;text-align:left;white-space:nowrap">Numero/Ano</th>' +
    '<th style="padding:10px;text-align:left;white-space:nowrap">Autor</th>' +
    '<th style="padding:10px;text-align:left">Ementa</th>' +
    '</tr></thead>' +
    '<tbody>' + blocos + '</tbody>' +
    '</table>' +
    '<p style="margin-top:16px;font-size:12px;color:#999;padding:0 4px">Consulta completa: <a href="' + VDOC_HOME + '" style="color:' + COR + '">V-Doc ALECE</a></p>' +
    '</div>';

  await transporter.sendMail({
    from:    '"Monitor ALECE" <' + EMAIL_REMETENTE + '>',
    to:      EMAIL_DESTINO,
    subject: 'ALECE: ' + novas.length + ' nova(s) proposicao(oes) - ' + new Date().toLocaleDateString('pt-BR'),
    html,
  });

  console.log('Email enviado com ' + novas.length + ' proposicoes novas.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Iniciando monitor ALECE (Ceara)...');
  console.log(new Date().toLocaleString('pt-BR'));

  const estado    = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas.map(String));

  const raw = await buscarProposicoes();

  if (raw.length === 0) {
    console.log('Nenhuma proposicao retornada. Encerrando sem alterar estado.');
    process.exit(0);
  }

  const proposicoes = raw
    .map(normalizarProposicao)
    .filter(p => p.id && p.id !== 'null');

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log('Proposicoes novas: ' + novas.length);

  if (novas.length > 0) {
    novas.sort((a, b) => {
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0);
    });

    await enviarEmail(novas);

    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
  } else {
    console.log('Sem novidades. Nada a enviar.');
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
