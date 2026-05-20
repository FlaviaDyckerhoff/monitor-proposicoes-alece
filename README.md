# Monitor Proposições ALECE — Ceará

Monitor automático de proposições da Assembleia Legislativa do Estado do Ceará (ALECE), rodando via GitHub Actions 4×/dia, sem custo.

## Como funciona

- Consulta o endpoint AJAX do sistema V-Doc (`ajaxLocalizarProcessos.jsp`) diretamente, sem CAPTCHA
- Busca separadamente os tipos PL, PLC, PEC, Mensagem e PIL para não depender do fluxo geral do V-Doc
- O CAPTCHA do site protege apenas o submit do formulário HTML — o endpoint AJAX é público
- Compara com `estado.json` para detectar proposições novas
- Envia email via Gmail quando há novidades

## Stack

- Node.js 20 (fetch nativo — sem Playwright, sem puppeteer)
- nodemailer + Gmail App Password
- GitHub Actions (cron 4×/dia, gratuito)

## Tipo de sistema identificado

**V-Doc (Qualidata/Atabix)** — JSP server-side com endpoint AJAX público separado do formulário.
Sistema proprietário usado pela ALECE, diferente de SAPL, SGPL Inlesp e API PR.

## Endpoint consultado

```
GET https://vdocleg.al.ce.gov.br/vdoc_leg/ajax/ajaxLocalizarProcessos.jsp
  ?comando=exibirRegistrosLocalizarProcessos
  &limite=20
  &pagina=1
  &codigoCategoriaAssunto=1
  &codigoAssuntoSelecionado=3
  &codigoLotacaoSelecionada=0
  &codigoClassificacaoPCTT=0
  &ordenacaoAtualLocalizarProcesso=undefined
  (demais parâmetros vazios; o `codigoAssuntoSelecionado` varia por tipo monitorado)
```

Resposta em XML com campos: `codigoProcesso`, `numeroProcesso`, `anoProcesso`, `assunto`, `ementa`, `autor`.

## Setup

### 1. Secrets no GitHub

Settings → Secrets and variables → Actions → New repository secret

| Secret | Valor |
|---|---|
| `EMAIL_REMETENTE` | Gmail remetente |
| `EMAIL_SENHA` | App Password 16 chars (sem espaços) |
| `EMAIL_DESTINO` | Email de destino dos alertas |

### 2. Estrutura do repositório

```
monitor-proposicoes-ce/
├── monitor.js
├── package.json
├── estado.json
├── README.md
└── .github/workflows/monitor.yml
```

### 3. Primeiro teste

Actions → Monitor Proposições CE → Run workflow

O primeiro run após mudança de escopo cria baseline sem enviar backlog histórico. A partir do segundo run, só notifica novidades.

## Tipos monitorados

| Código V-Doc | Tipo |
|---|---|
| 1 | PEC — Proposta de Emenda Constitucional |
| 2 | Mensagem |
| 3 | PL — Projeto de Lei |
| 4 | PLC — Projeto de Lei Complementar |
| 7 | PIL — Projeto de Indicação |

## Campos mapeados

| Email | XML |
|---|---|
| ID interno | `codigoProcesso` |
| Número | `numeroProcesso` |
| Ano | `anoProcesso` |
| Tipo | `assunto` (ex: PROJETO DE LEI, INDICAÇÃO) |
| Ementa | `ementa` |
| Autor | `autor` |
