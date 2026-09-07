Werk als senior engineer in de Consultatie repository op een verse branch/worktree vanaf actuele origin/main. Dit is een productie-correctheids- en performancebug in PDF-with-comments.

Brondata: download read-only de echte annotatie-JSONL van:
https://gitlab.com/datastelsel.nl/federatief/simulation/consultatie-data/-/raw/main/annotations/019f13c9-d4cf-77e9-a3e1-426838b6109e.jsonl?ref_type=heads
Henk meldt dat de PDF voor VNG (ongeveer 69 opmerkingen) sommige opmerkingen mist, gele highlights op verkeerde passages zet, en nog circa 15 seconden genereert.

Opdracht:
1. Baseer op actuele origin/main, inspecteer AGENTS.md volledig, maak branch `fix/pdf-real-vng-comments`.
2. Reproduceer end-to-end met het echte consultatiedocument en de VNG-subset uit JSONL. Bepaal exact welke comments ontbreken, drifted zijn of verkeerd aan een duplicaat/vergelijkbare passage gekoppeld worden. Bewaar geen gevoelige ruwe data in git tenzij repositorybeleid en bestaande fixtures dat duidelijk toestaan; maak zo nodig een minimale afgeleide/geanonimiseerde regressiefixture.
3. Diagnoseer correctness grondig. Denk aan duplicate quote placement, normalisatie, opmaakgrenzen, Unicode/whitespace, gewijzigde documentversie, quote-context en collision/claimed-span gedrag. Los de generieke oorzaak op, geen VNG-hardcoding.
4. Profileer de 69-comments real-data generatie. Splits Pandoc/Typst detect/final render/PDF annotatie en matchingtijd. Verbeter veilig; behoud de eerdere 1000-comments performance en alle label/Typst-syntax regressies.
5. Voeg exacte regressietests toe voor missing/wrong highlight en een realistische performance test/benchmark met duidelijke voor/na-metingen. Verifieer PDF annotations/highlights inhoudelijk, niet alleen dat output een PDF is.
6. Draai gerichte tests, volledige pdfexport suite incl. 1000 comments, `mise run generate && go test ./... -count=1`, lint en relevante race/vet checks. Geen review-loop.
7. Commit, push en open een DRAFT MR tegen main. Rapporteer root cause, welke VNG-comments nu geplaatst/drifted zijn, performance voor/na, testresultaten en MR URL. Schrijf eindresultaat naar `/home/dev/foreman/state/consultatie-pdf-real-vng-result.md` en last message.

Werk autonoom, maar wijzig niets buiten branch/worktree en merge niet.
