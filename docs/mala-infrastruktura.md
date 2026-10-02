# Zapojení do malé vlastní infrastruktury

*[English](small-infrastructure.md)*

Popisuje sestavu, pro kterou server vznikl: jeden domácí nebo kancelářský stroj, na kterém běží
Stalwart pro rodinu nebo pár lidí, před ním reverzní proxy a na notebooku každého Claude
Desktop. Názvy hostitelů jsou příklady.

## Jak to vypadá

```text
 notebook                                 tvůj server
┌───────────────────────────┐            ┌──────────────────────────────────────────────┐
│ Claude Desktop            │            │ reverzní proxy (Traefik / Caddy / nginx), TLS│
│  └─ Stalwart Mail MCP ────┼── HTTPS ──▶│   /.well-known/jmap, /jmap/*  ──▶ Stalwart   │
│      (místní proces)      │   JMAP     │   (správcovské API zůstává uvnitř)           │
│  └─ další tvoje MCP       │            │ Stalwart: SMTP · IMAP · JMAP · CardDAV       │
└───────────┬───────────────┘            │ webmail (volitelně) na stejném názvu         │
            │ volitelně, jen skeny       └──────────────────────────────────────────────┘
            ▼
      Mistral OCR API
```

MCP server je místní proces na notebooku. Drží heslo schránky (z klíčenky), mluví s tvým
serverem přes JMAP a dává Claudovi deset nástrojů. Na straně serveru není potřeba žádný
doplněk, účet navíc ani API klíč — jen JMAP dostupný přes HTTPS.

## Co musí server nabízet

1. **JMAP přes HTTPS** na veřejném názvu (nebo dostupném přes VPN) s platným certifikátem.
2. **Dvě cesty přes reverzní proxy**: `/.well-known/jmap` a všechno pod `/jmap` (session,
   API, nahrávání i stahování žijí tam). Nic dalšího potřeba není — správcovské API a správu
   Stalwartu na veřejný router nedávej.
3. **Adresy v session musí ukazovat na veřejný název.** Klient si z objektu session přečte
   `apiUrl`, `uploadUrl` a `downloadUrl` a volá je tak, jak jsou. Ověření:

   ```bash
   curl -s -u jana@example.com https://mail.example.com/.well-known/jmap -L | head -c 600
   ```

   Když adresy ukazují na vnitřní název nebo `http://`, oprav nejdřív veřejnou adresu
   Stalwartu / hlavičky proxy — jinak by hledání fungovalo, ale přílohy a odesílání ne.
4. **Ke Stalwartu musí dojít skutečná IP klienta.** Stalwart banuje adresy, které hádají
   hesla. Když vidí jen adresu proxy, jedno špatně opsané heslo v nastavení něčího rozšíření
   zabanuje proxy, tedy všechny. Předej IP klienta dál (PROXY protocol nebo důvěryhodné
   hlavičky) a bany zůstanou na jednom člověku.

Router Traefiku pro JMAP vypadá takto (file provider):

```yaml
http:
  routers:
    stalwart-jmap:
      rule: "Host(`mail.example.com`) && (PathPrefix(`/jmap`) || Path(`/.well-known/jmap`))"
      entryPoints: [websecure]
      service: stalwart-web
      tls: {}
  services:
    stalwart-web:
      loadBalancer:
        servers:
          - url: "http://stalwart:8080"
```

Pokud ti proti Stalwartu už běží webmail přes JMAP, cesty jsou hotové a není co měnit.

## Účty a přihlášení

- Každý se přihlašuje **svou schránkou** — stejnou adresou a heslem jako v telefonu. Pokud
  tvůj Stalwart nabízí hesla aplikací, použij pro rozšíření jedno z nich, ať jde zrušit
  samostatně.
- `STALWART_TOKEN` přijme místo hesla přístupový token OAuth (posílá se jako Bearer), pokud
  si tokeny vydáváš sám; rozšíření žádné interaktivní přihlášení OAuth nemá.
- **Sdílené schránky a skupiny** se na klientu nenastavují: každý účet, ke kterému má
  přihlášený uživatel přístup, je v JMAP session a nástroje ho berou parametrem `account`
  (`account: "rodina"`). Vypíše je `mail_list_mailboxes`. Sdílený účet má vlastní složky,
  odesílací identitu i adresář.
- **Kontakty** jsou adresáře serveru (JMAP for Contacts). Tytéž adresáře se do telefonů
  synchronizují přes CardDAV, takže kontakt, který Claude přidá do sdíleného adresáře, se
  objeví všem v telefonu.

## Co Claude může a co ne

- Čte, hledá, zakládá koncepty a odesílá **jako ten člověk** — nic víc, než dovolí heslo
  schránky, a nic v cizích soukromých schránkách.
- Odeslání je okamžité. Popisy nástrojů modelu ukládají posílat jen na výslovný pokyn
  a jinak uložit koncept; koncepty jsou vidět ve webmailu i v telefonu ke kontrole. Kdo chce
  tvrdou pojistku místo pokynu, vypne v nastavení rozšíření **Povolit odesílání** — nástroje
  pro odeslání pak pro model neexistují — nebo si je v klientu nechá schvalovat ručně.
- Přijatou ani odeslanou poštu smazat neumí; `mail_delete_draft` odmítne cokoli, co není
  koncept.
- Přílohy se ukládají na notebook (výchozí `~/Downloads/Mail-Attachments`).

## Co odchází z počítače

| Data | Kam jdou |
|---|---|
| heslo schránky, veškerý poštovní provoz | jen na tvůj Stalwart |
| obsah zpráv a příloh, které model čte | k AI klientu, který používáš (jako výstup každého nástroje) |
| naskenované strany PDF a fotky, když je zapnuté OCR | Mistral OCR API |

OCR je vypnuté, dokud není vyplněný klíč Mistralu, a `ocr: false` ho přeskočí u jedné přílohy.

## Jedno rozšíření pro celou domácnost

Psát adresu serveru je pro většinu lidí o jedno pole víc, než je zdrávo. Vyrob **předvolbu**:
kopii manifestu s předvyplněným serverem, vlastním názvem a ikonou a — pokud chceš, aby se
nástroje v rozhovoru četly přirozeně — s vlastní předponou a výchozím jazykem.

```text
moje-predvolba/
  manifest.json     name, display_name, výchozí server_url, env: MAIL_TOOL_PREFIX, MAIL_BRAND, MAIL_LANG
  icon.png
```

```bash
./pack.sh --preset ~/infra/moje-predvolba      # → ~/infra/moje-predvolba/<name>.mcpb
```

Soubor `.mcpb` rozdej lidem (není tajný, žádné přihlašovací údaje v něm nejsou); otevřou ho,
zadají e-mail a heslo a je hotovo. Předvolbu drž vedle ostatní konfigurace infrastruktury
a přestav ji, kdykoli se tento repozitář posune. Její `name` neměň, aby klient nabídl
aktualizaci, a ne druhé rozšíření.

## Kombinace s dalšími nástroji

Smysl pošty za MCP je v tom, že se v jednom rozhovoru potká s ostatními daty:

- oborový nástroj (CRM, databáze nemovitostí, fakturace jako vlastní MCP server) a pošta:
  „podívej se, jestli už makléř odpověděl, přečti přiložený průkaz energetické náročnosti
  a doplň zjištění k záznamu“;
- ranní naplánovaná úloha: nepřečtená pošta od včerejška podle odesílatelů, s přílohami
  shrnutými;
- odpovědi z poznámek — Claude napíše koncept, ty ho odešleš z telefonu.

Každou oblast drž ve vlastním MCP serveru; tenhle zná jen poštu a kontakty.

## Provozní poznámky

- **Bany**: po změně hesla uprav nastavení rozšíření dřív, než zavoláš další nástroj. Ban se
  projeví jako odmítnuté spojení nebo 401 po nějakou dobu; zmizí sám, nebo ho zrušíš ve
  správě Stalwartu.
- **Aktualizace**: `git pull && ./pack.sh` (nebo `--preset …`) a otevřít nový `.mcpb`.
- **Záloh** se netýká — server nedrží žádný stav, všechno je ve Stalwartu.
- **Monitoring**: sonda na `https://mail.example.com/.well-known/jmap` řekne, že cesta, na
  které rozšíření stojí, žije — bez přihlášení Stalwart odpoví 307 na `/jmap/session`, která
  vrátí anonymní session (200, schopnosti serveru, ale žádné účty).
