# Painel de Metas – Conecta

Sistema web para acompanhar as metas do ano de cada colaborador, com times e supervisores, fotos de evidência e geração da apresentação de fim de ano (no navegador ou em PowerPoint).

## O que cada perfil faz

| Perfil | Vê | Edita |
|---|---|---|
| **Colaborador** | Só as próprias metas | As próprias metas, fotos e ideias |
| **Supervisor** | As próprias metas e as de todas as pessoas dos times que supervisiona | Só as próprias metas |
| **Administrador** | Tudo | As próprias metas; cadastra pessoas e times |

As regras ficam no servidor: um colaborador não consegue abrir a meta de outro nem trocando o endereço no navegador. Fotos seguem a mesma regra.

Telas:

- **Minhas metas**: painel com peso, frentes, etapas, fotos (antes/depois), ideias, troca de ano, importação do Trello e botão **Gerar apresentação**.
- **Meu time / Times**: atingimento de cada pessoa do time, média do time e acesso às metas de cada um (somente leitura, com a opção de gerar a apresentação da pessoa).
- **Administração**: cadastro de pessoas, perfis, times e supervisores; links de convite e de nova senha.

## Como funciona o acesso

1. O administrador cadastra a pessoa (nome, e-mail, cargo, perfil e time).
2. O sistema gera um **link de convite** (vale 7 dias). Se o e-mail estiver configurado, ele é enviado automaticamente; se não, o administrador copia o link e envia por WhatsApp/Teams.
3. A pessoa abre o link, cria a senha e já entra no painel.
4. Esqueceu a senha? Com e-mail configurado, ela usa "Esqueci minha senha" na tela de login. Sem e-mail, o administrador gera um **link de nova senha** (vale 2 horas).

Senhas são guardadas com bcrypt, a sessão fica em cookie seguro (`HttpOnly`) e o login tem limite de tentativas.

---

## Instalação na VPS (Docker)

Pré-requisitos: uma VPS Linux com **Docker** e **Docker Compose**, portas **80** e **443** liberadas e um **domínio** (ex.: `metas.suaempresa.com.br`) apontando para o IP da VPS (registro DNS tipo A).

```bash
# 1. Baixar o código
git clone https://github.com/andrefonseca17/metas-conecta.git
cd metas-conecta

# 2. Configurar
cp .env.example .env
nano .env          # preencha DOMINIO, BASE_URL, DB_PASSWORD e os dados do primeiro administrador

# 3. Subir
docker compose up -d --build

# 4. Acompanhar a inicialização
docker compose logs -f app
```

Pronto: acesse `https://SEU-DOMINIO` e entre com o `ADMIN_EMAIL` e `ADMIN_PASSWORD` do `.env`. O certificado HTTPS é emitido automaticamente pelo Caddy (Let's Encrypt) na primeira visita.

> Depois do primeiro acesso, troque a senha do administrador em **Conta → Trocar senha**. O `ADMIN_PASSWORD` só é usado na primeira vez que o sistema sobe.

### Instalação em servidor interno (sem domínio)

Se for usar só dentro da rede da empresa, sem HTTPS:

1. No `docker-compose.yml`, apague (ou comente) todo o bloco `caddy:` e descomente a linha `ports: ["3000:3000"]` do serviço `app`.
2. No `.env`, use `COOKIE_SECURE=false`, `BASE_URL=http://IP-DO-SERVIDOR:3000` e deixe `DOMINIO=interno` (qualquer valor).
3. `docker compose up -d --build` e acesse `http://IP-DO-SERVIDOR:3000`.

### E-mail (opcional)

Preencha `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM` no `.env` (o mesmo servidor de e-mail que a empresa já usa; no Microsoft 365 é `smtp.office365.com`, porta 587; no Google Workspace, `smtp.gmail.com`, porta 587 com senha de app). Depois rode `docker compose up -d`.

### Atualizar para uma versão nova

```bash
git pull
docker compose up -d --build
```

Os dados ficam em volumes do Docker (`pgdata` para o banco, `uploads` para as fotos) e não são apagados na atualização.

### Backup

```bash
# Banco de dados
docker compose exec -T db pg_dump -U metas metas > backup-metas-$(date +%F).sql
# Fotos
docker compose cp app:/data/uploads ./backup-fotos-$(date +%F)
```

Restaurar o banco: `docker compose exec -T db psql -U metas metas < backup-metas-AAAA-MM-DD.sql`.

### Esqueceu a senha do administrador?

```bash
docker compose exec app node scripts/nova-senha.js --email andre@suaempresa.com.br
```

O comando mostra um link de uso único para criar uma nova senha.

## Trazer as metas do painel antigo

1. Cadastre a pessoa na Administração (ou use o próprio administrador).
2. Coloque o arquivo `dados.json` exportado (e a pasta `fotos/`, se houver) dentro da pasta `migracao/` do projeto, na VPS.
3. Rode:

```bash
docker compose exec app node scripts/importar.js --email andre@suaempresa.com.br --pasta migracao
```

Use `--substituir` para apagar o que a pessoa já tiver antes de importar.

---

## Desenvolvimento local

Requer Node.js 20+ e um PostgreSQL.

```bash
npm install
DATABASE_URL=postgres://usuario:senha@localhost:5432/metas \
COOKIE_SECURE=false ADMIN_EMAIL=admin@teste.com ADMIN_PASSWORD=Teste1234 \
npm start
# abra http://localhost:3000
```

### Estrutura

```
src/server.js      rotas da API, páginas e regras de acesso
src/access.js      quem pode ver os dados de quem
src/auth.js        senhas, sessões e links de convite/nova senha
src/schema.sql     tabelas do banco (criadas automaticamente)
public/app.html    painel (metas, time, administração e apresentação)
public/login.html  tela de login
public/senha.html  criação/redefinição de senha
scripts/importar.js  migração do painel antigo
scripts/nova-senha.js  link de nova senha pelo servidor
```

### API (resumo)

| Método | Rota | Quem |
|---|---|---|
| POST | `/api/auth/login`, `/api/auth/logout` | todos |
| POST | `/api/auth/definir-senha`, `/api/auth/esqueci` | todos |
| GET | `/api/me` · POST `/api/me/senha` | logado |
| GET | `/api/estado?pessoa=ID` | dono, supervisor do time, admin |
| PUT/PATCH/DELETE | `/api/docs/{goals\|boards\|settings}/{id}` | só o dono |
| POST/GET/DELETE | `/api/fotos[/id]` | envio e exclusão: dono; leitura: quem pode ver a pessoa |
| GET | `/api/pessoas`, `/api/times` | logado (filtrado pelo perfil) |
| GET/POST/PATCH | `/api/admin/usuarios`, `/api/admin/times` | admin |

Toda requisição que altera dados precisa do cabeçalho `X-Requested-With: metas` (proteção contra CSRF).
