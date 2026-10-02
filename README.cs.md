# Stalwart Mail MCP

*[English](README.md)*

MCP server, díky kterému Claude Desktop (a jakýkoli MCP klient přes stdio) pracuje se schránkou
na vlastním poštovním serveru [Stalwart](https://stalw.art): hledá a čte poštu včetně příloh
a skenů, odpovídá ve vlákně, odesílá, zakládá koncepty a hledá nebo přidává kontakty.

Se serverem mluví protokolem JMAP a přihlašuje se účtem schránky. Na server se nic neinstaluje.

```text
Claude Desktop ──stdio──▶ dist/index.cjs (Node, tento MCP server)
                              │  HTTPS · JMAP (RFC 8620 / 8621 / 9610)
                              ▼
                 https://mail.example.com/jmap   (reverzní proxy → Stalwart)
```

Existuje i **vzdálený režim**: tentýž server puštěný vedle Stalwartu a přidaný do Clauda jako
vlastní konektor, takže schránka funguje v claude.ai, v mobilních aplikacích i v každém
desktopovém chatu — lidé se přihlašují přes OAuth samotného Stalwartu a server žádné
přihlašovací údaje nedrží. Viz [docs/vzdaleny-server.md](docs/vzdaleny-server.md).

Jak ho zapojit do malé vlastní infrastruktury — reverzní proxy, co pustit ven, sdílené
schránky, vlastní balíček pro rodinu nebo tým — popisuje
[docs/mala-infrastruktura.md](docs/mala-infrastruktura.md).

## Nástroje

Názvy mají předponu, výchozí je `mail_` (vlastní balíček si ji může změnit).

| Nástroj | Co dělá |
|---|---|
| `mail_list_mailboxes` | účty (vlastní + sdílené), složky s počty, povolení odesílatelé, adresáře |
| `mail_search_emails` | fulltext / od / komu / předmět / složka / datum / nepřečtené / s přílohou, nebo celé vlákno |
| `mail_get_email` | celá zpráva podle id (HTML → text) s číslovaným seznamem příloh |
| `mail_get_attachment` | obsah přílohy: text, PDF po stranách, OCR skenů a fotek dokumentů, obrázky; soubor uloží na disk |
| `mail_send_email` | odeslat nový mail nebo odpověď (`in_reply_to_id`, `reply_all`), přílohy z disku |
| `mail_create_draft` | totéž, ale jen uložit do Konceptů |
| `mail_send_draft` / `mail_delete_draft` | odeslat / smazat koncept podle id |
| `mail_search_contacts` | adresáře všech účtů a navíc odesílatelé a adresáti z historie pošty |
| `mail_add_contact` | nový kontakt (vlastní nebo sdílený adresář) |

Odeslání je okamžité a nejde vzít zpět, proto popisy nástrojů modelu říkají, že má posílat jen
na výslovný pokyn uživatele a jinak založit koncept.

## Instalace

### Claude Desktop (rozšíření)

Stáhni `stalwart-mail.mcpb` z
[posledního vydání](https://github.com/cybersmurf/stalwart-mail-mcp/releases/latest) a otevři
ho — Claude Desktop nabídne instalaci. Nebo si ho sestav:

```bash
npm install
./pack.sh                  # → stalwart-mail.mcpb
open stalwart-mail.mcpb    # Claude Desktop → Install
```

Vyplň adresu serveru, e-mail a heslo schránky. Volitelně jazyk a klíč Mistral API pro OCR.
Heslo se ukládá do klíčenky systému.

### Jakýkoli MCP klient (stdio)

Server je na npm jako [`stalwart-mail-mcp`](https://www.npmjs.com/package/stalwart-mail-mcp)
a v [registru MCP](https://registry.modelcontextprotocol.io) jako
`io.github.cybersmurf/stalwart-mail-mcp`, takže není potřeba nic stahovat:

```json
{
  "mcpServers": {
    "stalwart-mail": {
      "command": "npx",
      "args": ["-y", "stalwart-mail-mcp"],
      "env": {
        "STALWART_URL": "https://mail.example.com",
        "STALWART_USER": "jana@example.com",
        "STALWART_PASSWORD": "…"
      }
    }
  }
}
```

Claude Code: `claude mcp add stalwart-mail --env STALWART_URL=https://mail.example.com --env STALWART_USER=jana@example.com --env STALWART_PASSWORD=… -- npx -y stalwart-mail-mcp`

### Claude na webu, v desktopovém chatu a v telefonu

Pusť server vedle Stalwartu (`stalwart-mail-mcp --http`, nebo obraz pro Docker) a přidej jeho
adresu jako vlastní konektor — krok za krokem v
[docs/vzdaleny-server.md](docs/vzdaleny-server.md).

## Nastavení

| Proměnná | Význam |
|---|---|
| `STALWART_URL` | veřejná adresa serveru, např. `https://mail.example.com` (povinné) |
| `STALWART_USER` | schránka, kterou se přihlašuješ (povinné) |
| `STALWART_PASSWORD` | heslo schránky nebo heslo aplikace — posílá se jako Basic auth |
| `STALWART_TOKEN` | přístupový token OAuth místo hesla — posílá se jako Bearer |
| `MAIL_LANG` | `auto` (výchozí: jazyk počítače, angličtina, když ho neumíme) nebo kód jazyka |
| `MAIL_TOOL_PREFIX` | předpona názvů nástrojů, výchozí `mail` |
| `MAIL_BRAND` | zobrazovaný název serveru, výchozí `Stalwart Mail` |
| `MAIL_DOWNLOAD_DIR` | kam se ukládají přílohy, výchozí `~/Downloads/Mail-Attachments` |
| `MAIL_TIMEZONE` | časové pásmo (IANA) pro data ve výstupu, výchozí pásmo počítače |
| `MAIL_OCR_PROVIDER`, `MAIL_OCR_API_KEY`, `MAIL_OCR_MODEL`, `MAIL_OCR_BASE_URL` | kdo čte skeny — viz [Poskytovatelé OCR](#poskytovatelé-ocr) |
| `MISTRAL_API_KEY` | zkratka: když je nastavený jen tenhle, skeny jdou do Mistral OCR |
| `MAIL_ALLOW_SEND` | `false` odebere `send_email` a `send_draft` |
| `MAIL_ALLOW_DRAFTS` | `false` odebere `create_draft` a `delete_draft` |
| `MAIL_ALLOW_CONTACT_EDIT` | `false` odebere `add_contact` |
| `MAIL_ALLOW_ATTACHMENTS` | `false` odebere `get_attachment` |
| `MAIL_SAVE_ATTACHMENTS` | `false` = otevřené přílohy se jen přečtou, na disk se nic nezapíše |

## Co smí dělat

Každá schopnost je přepínač v nastavení rozšíření (nebo proměnná výše), ve výchozím stavu je
vše zapnuté. Vypnutá schopnost se **jako nástroj vůbec nenabídne**, takže platí bez ohledu na
to, co si pamatují schvalovací dotazy klienta:

- vypnuté odesílání → schránka, kterou Claude čte a píše do ní koncepty, ale nikdy z ní neodešle;
- vypnuté odesílání, koncepty i úpravy kontaktů → schránka jen pro čtení;
- vypnuté ukládání příloh → `get_attachment` čte soubor z dočasné kopie a je označený jako
  nástroj jen pro čtení; se zapnutým ukládáním zapisuje do složky stahování a je označený jako
  zapisující, s čímž klienti mohou při schvalování zacházet jinak.

Samotné schvalování („povolit jednou / povolit vždy“) patří klientovi, ne tomuto serveru.
V Claude Desktop se nastavuje po nástrojích v nastavení rozšíření; po aktualizaci, která změní
definici nástroje, se klient může zeptat znovu.

## Přílohy a OCR

`mail_get_attachment` stáhne soubor a vrátí to, co model přečte:

- textové soubory jako text, HTML převedené na text;
- PDF jako text po stranách (u dlouhých `page_from` / `page_to`);
- strany PDF bez textové vrstvy (skeny) a fotky jdou ke zvolenému **poskytovateli OCR** —
  výsledkem je markdown včetně tabulek a takové strany jsou označené `(OCR)`. U smíšeného PDF
  se posílají jen naskenované strany;
- obrázky se vrací jako obrázky; cokoli nad ~600 kB nebo v HEIC se na macOS zmenší (`sips`);
- ostatní typy (docx, xlsx, zip…) se jen uloží a vrátí se cesta.

Bez poskytovatele nebo s `ocr: false` se sken vrátí jako obrázek 1. strany (macOS)
s poznámkou. OCR je jediná věc, která z tohoto serveru posílá obsah jinam než na tvůj poštovní
server — ke zvolenému poskytovateli, nebo s lokálním modelem vůbec nikam.

### Poskytovatelé OCR

| `MAIL_OCR_PROVIDER` | Co to je | Potřebuje | Čte PDF |
|---|---|---|---|
| `auto` (výchozí) | Mistral, když je nastavený `MISTRAL_API_KEY`; vlastní server, když je zadaná adresa a model; jinak vypnuto | — | — |
| `mistral` | Mistral OCR (`mistral-ocr-latest`) | klíč | přímo |
| `anthropic` | Claude přes oficiální SDK (výchozí model `claude-opus-5-5`) | klíč | přímo |
| `openai`, `openrouter`, `gemini` | hostovaná API kompatibilní s OpenAI (chat s obrázky) | klíč + model | obrázky stran |
| `ollama`, `lmstudio` | lokální modely na `localhost` | model | obrázky stran |
| `custom` | jakýkoli jiný server kompatibilní s OpenAI | `MAIL_OCR_BASE_URL` + model | obrázky stran |
| `off` | bez OCR | — | — |

Volbu doplňují `MAIL_OCR_API_KEY`, `MAIL_OCR_MODEL` a `MAIL_OCR_BASE_URL`. Příklady:

```bash
MAIL_OCR_PROVIDER=ollama      MAIL_OCR_MODEL=llama3.2-vision                         # čistě lokálně
MAIL_OCR_PROVIDER=openrouter  MAIL_OCR_API_KEY=…  MAIL_OCR_MODEL=<model s viděním>
MAIL_OCR_PROVIDER=anthropic   MAIL_OCR_API_KEY=…
MAIL_OCR_PROVIDER=custom      MAIL_OCR_BASE_URL=http://nas.lan:8000/v1  MAIL_OCR_MODEL=…
```

Poskytovatelé, kteří berou jen obrázky, dostanou každou naskenovanou stranu jako PNG vytažené
z PDF (samotný sken, zmenšený na 2000 px). Stranu, která není jeden velký obrázek, jim předat
nejde a nahlásí se jako nepřečtená; Mistral a Anthropic čtou jakékoli PDF. Strany se posílají
po třech.

S čím počítat: lokální model může na hustou stranu potřebovat minutu i víc, což může
přesáhnout časový limit nástroje v klientu — dlouhé skeny čti po rozsazích stran. Obecné
modely s viděním přepisují dobře, ale jako každé OCR umí v tabulkách s grafikou posunout
buňky; `preview: true` přidá obrázek strany, aby si to model mohl zkontrolovat. U `anthropic`
se odmítnutý požadavek na aktuálních modelech Claude zopakuje na serveru na záložním modelu
(`fallbacks: "default"`).

`node test/live-ocr.mjs` pustí poskytovatele nastaveného v prostředí proti naskenovanému
testovacímu souboru (nebo tvému vlastnímu) a vypíše výsledek.

## Jazyky

Názvy a popisy nástrojů, výstupy i chybové hlášky jsou lokalizované. Angličtina je zdroj,
čeština je psaná ručně a němčina, španělština, francouzština, italština, nizozemština,
polština, portugalština a slovenština jsou **strojové překlady**, které zatím žádný rodilý
mluvčí nekontroloval — opravy jsou vítané.

Jazyk se přidává nebo opravuje v `src/locales/<kód>.ts` (zkopíruj `en.ts`, zachovej
`{zástupné značky}` a zalomení řádků) a registruje se v `src/locales/index.ts`. Překlad může
být neúplný, chybějící texty se vezmou z angličtiny. `npm run test:offline` každý jazyk
porovná s anglickými klíči.

## Vlastní balíčky (předvolby)

Pro rodinu nebo tým jde vyrobit rozšíření, kde je adresa serveru předvyplněná a lidé zadají
jen e-mail a heslo. Předvolba je složka s vlastním `manifest.json` (a volitelně `icon.png`),
viz [presets/example](presets/example).

```bash
./pack.sh --preset /cesta/k/predvolbe     # → /cesta/k/predvolbe/<name>.mcpb
```

Manifest předvolby nastaví přes `env` `MAIL_TOOL_PREFIX`, `MAIL_BRAND`, `MAIL_LANG` nebo
`MAIL_DOWNLOAD_DIR` a položce `server_url` dá výchozí hodnotu. `name` předvolby neměň, aby
Claude Desktop bral nové sestavení jako aktualizaci.

## Testy

```bash
npm run test:offline       # bez schránky: falešný JMAP + falešné OCR, skutečný server přes stdio
MISTRAL_API_KEY=… node test/offline.mjs --live-ocr    # navíc pošle testovací soubory do skutečného OCR
STALWART_URL=… STALWART_USER=… STALWART_PASSWORD=… node test/smoke.mjs          # skutečná schránka
STALWART_URL=… STALWART_USER=… STALWART_PASSWORD=… node test/smoke.mjs --send   # navíc pošle mail sám sobě
```

Offline test pokrývá přílohy, OCR, předponu nástrojů, výběr jazyka a úplnost překladů.
Kouřový test založí koncept a zase ho smaže; s `--send` po sobě nechá ve schránce jednu
testovací zprávu.

## Dobré vědět

- **Chybné heslo = ban IP** ve Stalwartu po několika pokusech. Server se přihlašuje až při
  prvním volání nástroje, ne při startu, takže restarty klienta ban nevyrobí; opakované volání
  se špatným heslem ano.
- Vzniklo pro Stalwart 0.16 a s ním se používá. Poštovní část je čisté RFC 8620/8621 a může
  fungovat i s jinými JMAP servery, ale to není vyzkoušené; kontakty potřebují JMAP for
  Contacts (RFC 9610).
- `Email/query` s `"inMailbox": null` Stalwart odmítne — filtr musí buď chybět, nebo mít id.
- Balíček je jeden soubor CommonJS (~3,8 MB, většinu dělá pdf.js z `unpdf`); přípona `.cjs`
  je nutná, protože `package.json` má `"type": "module"`.
- Výsledek nástroje má v Claude Desktop strop kolem 1 MB, proto limit 600 kB pro vložené
  obrázky.

## Licence

MIT
