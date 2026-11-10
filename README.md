# Stadsbouwer

Een stadsbouwspel geïnspireerd op *Cities: Skylines*, gemaakt in pure HTML, CSS en JavaScript.
Geen afhankelijkheden, geen build-stap.

## Starten

Open `index.html` in je browser, of start een lokale server:

```bash
npm start            # http://localhost:8080
```

## Bediening

| Actie | Hoe |
| --- | --- |
| Gereedschap kiezen | Klik in de linkerbalk, of gebruik de toetsen `Q`, `1`–`9`, `0`, `-` |
| Weg aanleggen | Gereedschap *Weg*, sleep een rechte lijn |
| Zonen | Gereedschap *Wonen*, *Commercieel* of *Industrie*, sleep een vak |
| Slopen | Gereedschap *Slopen*, sleep een vak |
| Dienst plaatsen | Klik op een lege tegel (park, politie, brandweer, school, centrale, waterpomp) |
| Tegel bekijken | Gereedschap *Inspecteren* (`Q`), klik op een tegel |
| Verschuiven | Rechter- of middelste muisknop ingedrukt houden, of slepen |
| Zoomen | Scrollen |
| Pauze / snelheid | `Spatie` pauzeert, de knoppen `1×` `2×` `3×` zetten de snelheid |
| Opslaan / laden | Knoppen *Opslaan* en *Laden* (opslag in de browser, ook automatisch elke 30 s) |

## Spelregels

- **Wegen** zijn de basis. Gebouwen en diensten moeten aan een weg liggen om te werken.
- **Wegnetwerken**: alles wat via wegen verbonden is, vormt één netwerk.
- **Stroom** komt van een centrale en **water** van een waterpomp. Die moeten aan een weg liggen, en de pomp moet naast water staan. Ze voeden alleen gebouwen in hetzelfde netwerk.
- **Vraag**: wonen groeit als er banen zijn, commercieel en industrie groeien als er inwoners zijn.
- **Groei**: gebouwen spawnen op gezoneerde tegels en worden hoger (niveau 1–3) als de vraag en het geluk hoog zijn.
- **Geluk** daalt bij vervuiling (industrie), tekorten aan stroom of water en hoge belasting. Parken, politie, brandweer, scholen en commercie verhogen het.
- **Economie**: belasting levert per dag geld op, wegen en diensten kosten onderhoud.

## Structuur

```
index.html       Pagina-indeling
style.css        Opmaak
js/sim.js        Simulatie (puur, zonder DOM): netwerken, groei, economie, opslaan
js/render.js     Isometrische weergave op canvas
js/ui.js         Muis- en toetsinvoer, HUD, begroting, opslaan/laden, gameloop
tests/           Unittests voor de simulatie (node:test)
```

## Tests

```bash
npm test
```

Vereist Node.js 18 of nieuwer. De tests draaien zonder browser.

## Beperkingen

Dit is een eerste versie. Er is nog geen verkeerssimulatie, geen misdaad, geen onderwijs- of
gezondheidszorgnetwerk, en geen terreinhoogte. Die zijn goede vervolgstappen.
