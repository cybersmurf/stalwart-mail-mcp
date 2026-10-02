# Vzdálený režim: pošta v Claudovi na webu, v desktopovém chatu a v telefonu

*[English](remote.md)*

Lokální server (`npx stalwart-mail-mcp`, rozšíření `.mcpb`) existuje jen na počítači, kde běží.
Aby šla schránka používat z claude.ai, z mobilních aplikací a z jakéhokoli chatu v desktopové
aplikaci, pusť tentýž server **vedle Stalwartu** a přidej ho do Clauda jako vlastní konektor.

```text
 Claude (web · desktop · telefon)              tvůj server
        │                              ┌──────────────────────────────────────────┐
        │ 1. přihlášení ───────────────┼─▶ Stalwart  /login, /auth/token  (OAuth) │
        │ 2. MCP + přístupový token ───┼─▶ tento server  /mcp                     │
        │                              │        └─ JMAP se stejným tokenem ─▶ Stalwart
        └──────────────────────────────┴──────────────────────────────────────────┘
```

Heslo se k tomuto serveru nikdy nedostane. Claude pošle člověka na přihlašovací stránku
Stalwartu, Stalwart vydá přístupový token omezený na poštu a kontakty a tento server ho jen
předá dál do JMAP. Nedrží žádný stav: žádná hesla, žádné tokeny na disku, žádnou poštu.

## Co je potřeba

- Stalwart s OAuth a JMAP dostupnými přes HTTPS (jsou, pokud funguje webmail).
- Klient OAuth pro Clauda zaregistrovaný ve Stalwartu (níž).
- Místo pro jeden malý kontejner a dvě další cesty na reverzní proxy.

## 1. Spuštění serveru

```bash
docker build -t stalwart-mail-mcp https://github.com/cybersmurf/stalwart-mail-mcp.git
docker run -d --name mail-mcp --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -e STALWART_URL=https://mail.example.com -e MCP_PUBLIC_URL=https://mail.example.com \
  stalwart-mail-mcp
```

nebo `npx -y stalwart-mail-mcp --http` se stejnými proměnnými, případně
[`docker-compose.example.yml`](../docker-compose.example.yml).

| Proměnná | Význam |
|---|---|
| `STALWART_URL` | tvůj Stalwart (povinné) |
| `MCP_PUBLIC_URL` | veřejná adresa, pod kterou je tento server dostupný, např. `https://mail.example.com` (povinné) |
| `STALWART_INTERNAL_URL` | volitelná přímá adresa Stalwartu ve vnitřní síti, např. `http://stalwart:8080` — volání JMAP pak nejdou přes veřejnou cestu |
| `MAIL_AUTH_SERVER` | kde se lidé přihlašují, když se liší od `STALWART_URL` |
| `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `MCP_HTTP_PATH` | výchozí `8787`, `0.0.0.0`, `/mcp` |
| `MAIL_LANG`, `MAIL_TOOL_PREFIX`, `MAIL_ALLOW_*`, `MAIL_OCR_*` | jako v lokálním režimu — tady platí pro všechny uživatele serveru |

## 2. Dvě cesty na reverzní proxy

Na názvu poštovního serveru pošli `/mcp` a `/.well-known/oauth-protected-resource` do
kontejneru. Všechno ostatní zůstává Stalwartu. Traefik (file provider):

```yaml
http:
  routers:
    mail-mcp:
      rule: "Host(`mail.example.com`) && (PathPrefix(`/mcp`) || PathPrefix(`/.well-known/oauth-protected-resource`))"
      entryPoints: [websecure]
      service: mail-mcp
      priority: 300            # nad obecným routerem poštovního názvu
      tls: {}
  services:
    mail-mcp:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8787"
```

Ověření:

```bash
curl -s https://mail.example.com/.well-known/oauth-protected-resource      # → resource + tvůj Stalwart jako přihlašovací server
curl -si -X POST https://mail.example.com/mcp | head -3                     # → 401 s hlavičkou WWW-Authenticate
```

Jde to i na samostatném názvu (`mcp.example.com`); pak na něj nastav `MCP_PUBLIC_URL`
a `STALWART_URL` nech na poštovním názvu.

## 3. Registrace Clauda jako klienta OAuth ve Stalwartu

Claude potřebuje klienta, kterého smí u tvého Stalwartu použít: **veřejného** (bez tajemství,
s PKCE) s těmito návratovými adresami:

```text
https://claude.ai/api/mcp/auth_callback
https://claude.com/api/mcp/auth_callback
```

Založ ho ve správě Stalwartu (klienti OAuth) a poznamenej si jeho ID — hodí se `claude`.
Pokud tvůj Stalwart povoluje dynamickou registraci klientů a `/auth/register` je dostupné
zvenku, Claude se zaregistruje sám a tenhle krok odpadá; většina malých instalací ale nechává
registraci zavřenou, což je bezpečnější výchozí stav.

## 4. Přidání do Clauda

V Claudovi: **Settings → Connectors → Add custom connector**, zadej
`https://mail.example.com/mcp`, otevři **Advanced settings** a vyplň ID klienta OAuth z kroku 3
(tajemství nech prázdné). Zvol **Connect**: otevře se přihlašovací stránka Stalwartu, přihlásíš
se schránkou a poštovní nástroje jsou v každém chatu — na webu, v desktopu i v telefonu.

Každý se připojuje svou schránkou; sdílené schránky, ke kterým má přístup, jdou přes parametr
`account` stejně jako v lokálním režimu.

## Co je jinak než v lokálním režimu

- **Žádné soubory.** Server na tvůj počítač nevidí: posílání příloh z disku se nenabízí
  a otevřené přílohy se přečtou a vrátí, ale nikam se neukládají.
- **OCR určuje provozovatel.** `MAIL_OCR_*` na serveru rozhoduje, kam jdou skeny všech. Když
  mají dokumenty zůstat doma, nasměruj ho na model na vlastním hardwaru.
- **Nastavení je na server**, ne na člověka: jazyk, předpona nástrojů a to, co je povoleno
  (`MAIL_ALLOW_SEND=false` z něj udělá server jen na koncepty pro všechny).
- **Schvalování** je Claudovo nastavení po nástrojích u konektoru, jako u každého konektoru.

## Bezpečnostní poznámky

- Server je stejně vystavený jako tvůj JMAP: přijme jen požadavky s tokenem, který vydal
  Stalwart, každý nový token si u Stalwartu ověří a na všechno ostatní odpoví 401. Tokeny
  drží v paměti nejvýš pět minut, aby je neověřoval při každém volání.
- Token, který má Claude, je omezený na vyžádané obory — poštu a kontakty — a vyprší podle
  nastavení Stalwartu; přístup zrušíš ve Stalwartu (autorizované aplikace uživatele, nebo
  změnou klienta) a konektor přestane fungovat.
- Na tvůj server volají servery Anthropicu; reverzní proxy vidí jejich adresy, ne adresu
  uživatele. Server sám odpoví 429 adrese, která za deset minut poslala víc než 30 odmítnutých
  tokenů, a na odmítnutý token se Stalwartu minutu znovu neptá.
- **Automatické bany Stalwartu:** každý vypršelý token znamená jedno neúspěšné přihlášení
  u Stalwartu, započítané adrese, kterou Stalwart vidí — se `STALWART_INTERNAL_URL` je to
  tento kontejner. Dej kontejneru pevnou adresu a přidej ji ve Stalwartu mezi povolené, jinak
  jednoho dne dávka vypršelých tokenů zabanuje konektor všem.
- Provozuj jen za TLS. Kontejner mluví čistým HTTP a má poslouchat na localhostu nebo ve
  vnitřní síti.
