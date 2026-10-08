# Pasta de migração

Coloque aqui o `dados.json` exportado do painel antigo (e a pasta `fotos/`, se houver) e rode:

```bash
docker compose exec app node scripts/importar.js --email SEU-EMAIL --pasta migracao
```

Os arquivos desta pasta não vão para o GitHub (estão no `.gitignore`), porque contêm dados pessoais.
