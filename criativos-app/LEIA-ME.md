# Criativos Dr. Padel - app de pedidos de criativos

O gestor de ads cria pedidos, o designer carrega os criativos e o gestor aprova ou pede alterações. Tudo fica guardado na tabela **CRIATIVOS ANUNCIOS** do Notion.

## 1. Ligação ao Notion (5 min)

1. Vai a https://app.notion.com/developers/connections → **Internal connections** → **Create a new connection**, com o nome "App Criativos" e o workspace DR PADEL (tens de ser dono do workspace).
2. No separador **Configuration**, ativa as capacidades: ler, atualizar e inserir conteúdo, ler comentários e inserir comentários.
3. Copia o **Installation access token**.
4. Abre a tabela CRIATIVOS ANUNCIOS no Notion e vai a `•••` → Connections → **+ Add connection** → escolhe "App Criativos". Sem este passo, a app dá erro.

Para ficheiros com mais de 5 MB (vídeos), o workspace do Notion tem de estar num plano pago. Num plano pago, cada ficheiro pode ter até 5 GB.

## 2. Publicar no Netlify

**Opção A - GitHub (recomendada):** põe esta pasta num repositório e, no Netlify, escolhe "Add new site → Import from Git". O Netlify lê o `netlify.toml` e instala tudo sozinho.

**Opção B - linha de comandos:** dentro desta pasta, corre:
```
npm install
npx netlify-cli deploy --prod
```

Não uses o arrastar-e-largar do Netlify: esse método não publica as functions.

## 3. Variáveis de ambiente (Netlify → Site configuration → Environment variables)

| Variável | Valor |
|---|---|
| `NOTION_TOKEN` | o token da ligação |
| `SESSION_SECRET` | uma frase longa e aleatória (mínimo 16 caracteres) |
| `USERS` | os PINs, ver exemplo abaixo |

Exemplo de `USERS` (papéis possíveis: `ads`, `design`, `admin`):
```
{"4821":{"nome":"Fábio","papel":"ads"},"7390":{"nome":"Designer","papel":"design"},"1958":{"nome":"Leonardo","papel":"admin"}}
```
Depois de mudar variáveis, faz "Trigger deploy" para aplicar. Para tirar o acesso a alguém, apaga o PIN do `USERS`: a sessão dessa pessoa deixa de funcionar.

## Como funciona

- **Gestor de ads (`ads`)**: cria e edita pedidos, junta referências, aprova, pede alterações (com comentário obrigatório) e marca como publicado. Abre na vista "Para rever".
- **Designer (`design`)**: começa o pedido, carrega os criativos e envia para revisão. Cada envio sobe a versão (v1, v2...).
- **Admin**: faz tudo e pode forçar qualquer estado.
- Os comentários ficam na página do Notion, com o nome de quem escreveu.
- Os ficheiros sobem aos pedaços e são guardados diretamente no Notion, por isso aguentam vídeos grandes.
- A pré-visualização mostra o criativo dentro de um anúncio (feed ou story), com as zonas tapadas pela interface.
- Pedidos publicados há mais de 45 dias deixam de aparecer na app, mas continuam no Notion.
