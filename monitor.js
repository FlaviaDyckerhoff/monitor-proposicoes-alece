const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO   = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA     = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO  = 'estado.json';

const VDOC_AJAX = 'https://vdocleg.al.ce.gov.br/vdoc_leg/ajax/ajaxLocalizarProcessos.jsp';
const VDOC_HOME = 'https://vdocleg.al.ce.gov.br/vdoc_leg/consultaExterna/localizarProcessos.jsp';

const PAGINAS_POR_RUN = 20;
const MONITOR_VERSION = 'alece-tipos-v2';

const TIPOS_MONITORADOS = [
  { codigo: '1', sigla: 'PEC', label: 'PEC - PROPOSTA DE EMENDA CONSTITUCIONAL' },
  { codigo: '2', sigla: 'MENSAGEM', label: 'MENSAGEM' },
  { codigo: '3', sigla: 'PL', label: 'PL - PROJETO DE LEI' },
  { codigo: '4', sigla: 'PLC', label: 'PLC - PROJETO DE LEI COMPLEMENTAR' },
  { codigo: '7', sigla: 'PIL', label: 'PIL - PROJETO DE INDICAÇÃO' },
];

const TIPO_LABELS = {
  'PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC - PROPOSTA DE EMENDA CONSTITUCIONAL',
  'MENSAGEM': 'MENSAGEM',
  'MENSAGENS': 'MENSAGEM',
  'PROJETO DE LEI': 'PL - PROJETO DE LEI',
  'PROJETO DE LEI COMPLEMENTAR': 'PLC - PROJETO DE LEI COMPLEMENTAR',
  'PROJETO DE INDICAÇÃO': 'PIL - PROJETO DE INDICAÇÃO',
  'PROJETO DE INDICACAO': 'PIL - PROJETO DE INDICAÇÃO',
};

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

async function buscarPagina(pagina, jsessionid, tipoMonitorado = null) {
  const codigoAssuntoSelecionado = tipoMonitorado ? tipoMonitorado.codigo : '';

  const params = new URLSearchParams({
    comando:                         'exibirRegistrosLocalizarProcessos',
    numeroProcesso:                  '',
    nomeParte:                       '',
    dataDe:                          '',
    dataAte:                         '',
    codigoCategoriaAssunto:          tipoMonitorado ? '1' : '',
    codigoFase:                      '',
    codigoSituacao:                  '',
    codigoLotacaoSelecionada:        '0',
    codigoAssuntoSelecionado,
    codigoClassificacaoPCTT:         '0',
    ordenacaoAtualLocalizarProcesso: 'undefined',
    observacoesProcesso:             '',
    limite:                          '20',
    pagina:                          String(pagina),
  });

  const url = VDOC_AJAX + '?' + params.toString();
  const prefixoTipo = tipoMonitorado ? tipoMonitorado.sigla + ' - ' : '';
  console.log('   ' + prefixoTipo + 'Pagina ' + pagina + '...');

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
  console.log('Consultando V-Doc da Assembleia Legislativa do Ceará...');

  const jsessionid = await obterSessao();
  // Pequena pausa após obter sessão — dá tempo do servidor registrar
  await new Promise(r => setTimeout(r, 800));

  const todas = [];

  for (const tipo of TIPOS_MONITORADOS) {
    console.log('   Tipo: ' + tipo.label);

    for (let p = 1; p <= PAGINAS_POR_RUN; p++) {
      const { registros, fim } = await buscarPagina(p, jsessionid, tipo);
      todas.push(...registros);
      if (fim) break;
      await new Promise(r => setTimeout(r, 600));
    }

    await new Promise(r => setTimeout(r, 600));
  }

  console.log(todas.length + ' proposicoes obtidas neste run');
  return todas;
}

// ─── Normalização ─────────────────────────────────────────────────────────────

function normalizarProposicao(p) {
  const numero = (p.numero || '').replace(/^0+/, '') || '-';
  const assunto = (p.tipo || 'OUTROS').trim().toUpperCase();
  const tipo   = TIPO_LABELS[assunto] || assunto;
  const ementa = (!p.ementa || p.ementa.trim() === '.')
    ? '(ementa nao disponivel)'
    : String(p.ementa).replace(/s+/g, ' ').trim();

  return {
    id:     String(p.id),
    tipo,
    numero,
    ano:    p.ano || String(new Date().getFullYear()),
    link:   VDOC_HOME + '?codigoProcesso=' + encodeURIComponent(String(p.id)),
    autor:  (p.autor || '-').trim(),
    ementa,
  };
}

// ─── Email ────────────────────────────────────────────────────────────────────

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function compararTiposEmail(a, b) {
  const prioridadeA = prioridadeTipoEmail(a);
  const prioridadeB = prioridadeTipoEmail(b);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario', 'Boticário', 'Abrasel', 'ANBRASEL',
  'Energisa', 'EnergisaLuz', 'SABESP', 'COMGAS', 'COMGÁS', 'Eletromidia', 'Eletromídia',
  'BRT', 'Regenera', 'Nova Infra', 'Seta', 'SETA', 'AkzoNobel', 'Expedia', 'RTSC',
  'Huawei', 'Carrefour', 'JBS', 'Ajinomoto', 'Vibra', 'Mindlab', 'ABVTEX', 'Neoenergia', 'ENEL',
  'Equatorial', 'Equatorial Goiás', 'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'Equtorial'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}

async function enviarEmail(novas) {
  anotarClientesCitados(novas);
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

  const blocos = Object.keys(porTipo).sort(compararTiposEmail).map(tipo => {
    const header = '<tr><td colspan="3" style="padding:10px 8px 4px;background:#e8f0fb;font-weight:bold;color:' + COR + ';font-size:13px;border-top:2px solid ' + COR + ';border-bottom:1px solid #c9d9f0">' + tipo + ' &mdash; ' + porTipo[tipo].length + ' proposicao(oes)</td></tr>';
    const rows = porTipo[tipo].map(p =>
      '<tr>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap;font-size:13px;vertical-align:top"><a href="' + p.link + '" style="color:' + COR + ';text-decoration:none"><strong>' + p.numero + '/' + p.ano + '</strong></a></td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee;color:#555;font-size:12px;white-space:nowrap;vertical-align:top">' + p.autor + '</td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top">' + renderizarEmentaCliente(p) + '</td>' +
      '</tr>'
    ).join('');
    return header + rows;
  }).join('');

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">' +
    '<div style="background:' + COR + ';padding:16px 20px;border-radius:6px 6px 0 0">' +
    '<h2 style="color:white;margin:0;font-size:18px">&#127963;&#65039; Assembleia Legislativa do Ceará &mdash; ' + novas.length + ' nova(s) proposicao(oes)</h2>' +
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
    '<p style="margin-top:16px;font-size:12px;color:#999;padding:0 4px">Consulta completa: <a href="' + VDOC_HOME + '" style="color:' + COR + '">V-Doc da Assembleia Legislativa do Ceará</a></p>' +
    '</div>';

  await transporter.sendMail({
    from:    '"Monitor Ceará" <' + EMAIL_REMETENTE + '>',
    to:      EMAIL_DESTINO,
    subject: '🏛️ Ceará: ' + novas.length + ' nova(s) proposicao(oes) - ' + new Date().toLocaleDateString('pt-BR'),
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

  if (estado.monitor_version !== MONITOR_VERSION) {
    proposicoes.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    estado.monitor_version = MONITOR_VERSION;
    salvarEstado(estado);
    console.log('Baseline da expansao de tipos criado sem enviar email historico: ' + proposicoes.length + ' proposicoes marcadas.');
    process.exit(0);
  }

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
