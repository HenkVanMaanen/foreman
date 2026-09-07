# Codex spike: rasterloze PDF-annotatiegeometrie

Werk in `/home/dev/consultatie-pdf-rasterless` op branch `spike/pdf-rasterless-geometry`, gebaseerd op MR !54
commit `feea896`. Dit is een read-only/prototype-spike: commit of push niets en wijzig MR !54 niet.

Henk vraagt of de PDF-export via een andere methode nog sneller kan. De 69-comments benchmark is 4,58s, waarvan
circa 4,13s zit in `pdftoppm` rasterisatie + PNG pixelscan. Onderzoek en prototypeer objectief minimaal:

1. Directe geometrie-export vanuit Typst (metadata/query/introspection, SVG of een andere machineleesbare output).
2. Rechtstreeks geometrie uit de door Typst gemaakte PDF halen via bestaande Go/PDF tooling, zonder PNG.
3. Alleen als 1/2 niet werken: relevante alternatieve renderer/HTML-to-PDF-route met dezelfde annotatiekwaliteit.

Eisen:
- Lees eerst de volledige huidige pipeline en tests op `feea896`.
- Maak kleine throwaway prototypes en meet cold/warm op realistische 69 en zo mogelijk 1000 reacties.
- Verifieer unieke IDs, popup-koppeling, duplicate quotes, overlap, multi-line en multi-page geometrie.
- Beoordeel dependency footprint, determinisme, security, CI/containerimpact en onderhoud.
- Geen ruwe VNG-data of persoonsgegevens; alleen bestaande/geanonimiseerde fixtures.
- Geef een duidelijke aanbeveling: route, bewezen timing, risico's, geschatte implementatiescope en of !54 eerst
  zelfstandig moet landen.
- Schrijf het eindrapport naar `/home/dev/foreman/state/consultatie-pdf-rasterless-result.md` en je final message
  naar de standaard Codex output. Geen commit, push, MR of review-loop.
