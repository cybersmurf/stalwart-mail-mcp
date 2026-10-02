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

```bash
npm install
./pack.sh                  # → stalwart-mail.mcpb
open stalwart-mail.mcpb    # Claude Desktop → Install
```

Vyplň adresu serveru, e-mail a heslo schránky. Volitelně jazyk a klíč Mistral API pro OCR.
Heslo se ukládá do klíčenky systému.

### Jakýkoli MCP klient (stdio)

```bash
npm install && npm run build
```

```json
{
  "mcpServers": {
    "stalwart-mail": {
      "command": "node",
      "args": ["/cesta/k/stalwart-mail-mcp/dist/index.cjs"],
      "env": {
        "STALWART_URL": "https://mail.example.com",
        "STALWART_USER": "jana@example.com",
        "STALWART_PASSWORD": "…"
      }
    }
  }
}
```

Claude Code: `claude mcp add stalwart-mail --env STALWART_URL=https://mail.example.com --env STALWART_USER=jana@example.com --env STALWART_PASSWORD=… -- node /cesta/k/stalwart-mail-mcp/dist/index.cjs`

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
| `MISTRAL_API_KEY` | zapne OCR skenů a fotek dokumentů (volitelné) |
| `MISTRAL_OCR_MODEL` | výchozí `mistral-ocr-latest` |
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

`mail_get_attachment` stáhne soubor do `MAIL_DOWNLOAD_DIR` a vrátí to, co model přečte:

- textové soubory jako text, HTML převedené na text;
- PDF jako text po stranách (u dlouhých `page_from` / `page_to`);
- strany PDF bez textové vrstvy (skeny) a fotky jdou s nastaveným klíčem do **Mistral OCR** —
  výsledkem je markdown včetně tabulek a takové strany jsou označené `(OCR)`. U smíšeného PDF
  se posílají jen naskenované strany;
- obrázky se vrací jako obrázky; cokoli nad ~600 kB nebo v HEIC se na macOS zmenší (`sips`);
- ostatní typy (docx, xlsx, zip…) se jen uloží a vrátí se cesta.

Bez klíče nebo s `ocr: false` se sken vrátí jako obrázek 1. strany (macOS) s poznámkou.
OCR posílá dokument do Mistralu — je to jediná věc, která z tohoto serveru odchází z počítače
ke třetí straně.

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
