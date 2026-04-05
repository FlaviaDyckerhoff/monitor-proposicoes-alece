# Monitor Proposições ALECE — Ceará

Monitor automático de proposições da Assembleia Legislativa do Estado do Ceará (ALECE), rodando via GitHub Actions 4×/dia, sem custo.

## Como funciona

- Consulta o endpoint AJAX do sistema V-Doc (`ajaxLocalizarProcessos.jsp`) diretamente, sem CAPTCHA
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
  &codigoLotacaoSelecionada=0
  &codigoClassificacaoPCTT=0
  &ordenacaoAtualLocalizarProcesso=undefined
  (demais parâmetros vazios)
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

O primeiro run envia o backlog recente e salva o estado. A partir do segundo run, só notifica novidades.

## Campos mapeados

| Email | XML |
|---|---|
| ID interno | `codigoProcesso` |
| Número | `numeroProcesso` |
| Ano | `anoProcesso` |
| Tipo | `assunto` (ex: PROJETO DE LEI, INDICAÇÃO) |
| Ementa | `ementa` |
| Autor | `autor` |
