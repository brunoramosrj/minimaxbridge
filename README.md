# MiniMaxBridge

Bridge local compatível com OpenAI e Anthropic que utiliza diretamente a sessão
web gratuita do `agent.minimax.io`. Não requer chave da API paga.

Este projeto é um fork do [johngbl/QwenBridge](https://github.com/johngbl/QwenBridge),
adaptado para autenticação, sessões e streaming do MiniMax Agent.

> Projeto não oficial. A API web do MiniMax Agent pode mudar sem aviso. Use de
> acordo com os termos da sua conta e nunca publique cookies, tokens, HARs ou o
> arquivo `.minimax-session.json`.

## Configuração

Requer Node.js 22 ou superior.

```bash
git clone https://github.com/brunoramosrj/minimaxbridge.git
cd minimaxbridge
cp .env.example .env
npm ci
```

```env
MINIMAX_EMAIL=usuario@exemplo.com
MINIMAX_PASSWORD=sua-senha
MINIMAX_SESSION_PATH=.minimax-session.json

# Opcional; exige sandbox do Agent Team e pode ser menos estável
MINIMAX_ENABLE_TEAM=false
MINIMAX_MAX_PROMPT_CHARS=70000

# Proteção opcional da API local
API_KEY=chave-local
HOST=127.0.0.1
PORT=3000
```

## Login HTTP direto

```bash
npm ci
npm run login
npm start
```

O login:

- registra o dispositivo;
- criptografa a senha com a chave RSA usada pelo site;
- percorre login, OAuth callback e renovação por HTTP;
- persiste token, `realUserId`, UUID, device ID e cookies técnicos;
- não abre navegador e não depende de HAR.

Credenciais ficam no `.env`. A sessão é salva em `.minimax-session.json` com
permissão `0600`. Ambos são ignorados pelo Git.

## OpenAI

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer chave-local' \
  -d '{
    "model": "MiniMax-M3",
    "messages": [{"role": "user", "content": "Olá"}],
    "stream": false
  }'
```

Use `session_id` ou `conversation_id` para continuar a mesma conversa upstream.
O bridge traduz texto, raciocínio, streaming e uso de tokens para o formato
OpenAI.

Com `MINIMAX_ENABLE_TEAM=false`, o bridge seleciona o agente builtin `chat`, que
não depende do sandbox do Mavis. Ao ativar Team, ele seleciona `mavis` e passa a
depender da disponibilidade do sandbox upstream.

## Endpoints

```text
POST /v1/chat/completions
POST /v1/messages
POST /v1/messages/count_tokens
GET  /v1/models
GET  /health
GET  /metrics
```

## Recuperação por HAR

Como alternativa de recuperação, uma sessão pode ser importada de
`agent.minimax.io.har` por meio das funções em `auth-minimax.ts`. HARs contêm
credenciais ativas e são ignorados pelo Git.

## Validação

```bash
npm run typecheck
npm test
```

O `npm run login` deve ser repetido quando a sessão expirar ou for invalidada.

## Origem e créditos

MiniMaxBridge preserva o histórico e componentes do QwenBridge, especialmente a
base HTTP/Hono, compatibilidade OpenAI/Anthropic e parser de chamadas de
ferramentas. A adaptação MiniMax adiciona login HTTP direto, assinatura das
requisições web, descoberta de agentes, gerenciamento de sessões e tradução do
stream do MiniMax Agent.

- Projeto original: [johngbl/QwenBridge](https://github.com/johngbl/QwenBridge)
- Adaptação MiniMax: [brunoramosrj/minimaxbridge](https://github.com/brunoramosrj/minimaxbridge)
- Contribuições anteriores preservadas no histórico Git e no `LICENSE`
