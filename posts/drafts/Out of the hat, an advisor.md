| Field   | Content                                    |
| ------- | ------------------------------------------ |
| Title   | Out of the hat, an advisor                 |
| Date    | April 2026                                 |
| Excerpt | What if Sonnet could ask Opus for help?    |
***
Un día mas vengo a ayudar a los pobres en tokens (como yo). ¿Y si Sonnet pudiera pedirle ayuda a Opus solo cuando hace falta, en vez de cobrarte Opus todo el rato? Con una línea en tu request. Sin sub-agentes, sin orquestación, sin mover contexto a mano generando plannings.

Para tareas sencillas Sonnet va sobrado, pero cuando el problema se complica se le hace cuesta arriba. La solución obvia es tirar de Opus, pero [Opus cuesta `$5/$25` por millón de tokens y Sonnet `$3/$15`](https://www.anthropic.com/claude/opus). Es decir, precio variable segun si es input o output y Opus costando bastante más. Viendo esta diferencia, no siempre tenemos claro cual usar y podemos malgastar nuestros preciados tokens.

La [advisor tool](https://claude.com/blog/the-advisor-strategy) es la solución de Anthropic a este dilema. Pones Sonnet como ejecutor y le das acceso a una `advisor tool` respaldada por Opus. Sonnet decide él mismo cuándo llamar al advisor: antes de tomar una decisión de diseño, antes de escribir código crítico o cuando ve que está perdido. Cuando lo llama, todo el historial de conversación se reenvía automáticamente a Opus, que devuelve su análisis. No hay handoff manual.

Lo más interesante son los números. En los benchmarks de Anthropic, Sonnet + Opus advisor mejora en BrowseComp2 y Terminal-Bench 2.0 **y cuesta menos por tarea que Sonnet solo**. Haiku con Opus de advisor saca 41.2% en BrowseComp — más del doble que el 19.7% de Haiku solo — a un 85% menos por tarea que Sonnet.

Si usas Claude Code:

```
/advisor
```

Disponible desde v2.1.101. Eliges modelo advisor (Opus), y a partir de ahí Sonnet lo invoca cuando le hace falta. 

Si lo usas vía API, tres cosas: el header `anthropic-beta: advisor-tool-2026-03-01`, el tool `advisor_20260301` en tu array de tools, y el modelo advisor dentro de la definición del tool (no en el `model` principal). Añade también `max_uses` para acotar el gasto por request:

```bash
curl https://api.anthropic.com/v1/messages \
  --header "x-api-key: $ANTHROPIC_API_KEY" \
  --header "anthropic-version: 2023-06-01" \
  --header "anthropic-beta: advisor-tool-2026-03-01" \
  --header "content-type: application/json" \
  --data '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 4096,
    "tools": [{
      "type": "advisor_20260301",
      "name": "advisor",
      "model": "claude-opus-4-7",
      "max_uses": 3
    }],
    "messages": [{"role": "user", "content": "..."}]
  }'
```

Un caso real para que se entienda mejor el caso de uso. Le pides a Sonnet: *"añade un toggle de idioma ES/EN al post `prozbul.html`, igual que el que ya existe en `defuddle-yourself.html`"*. Sonnet abre el archivo, ve el patrón (`<div class="language-toggle">`, una `switchLanguage()` inline y dos `<div class="lang-section">`), y se lanza a copiar-pegar la estructura. Plan razonable. Pero antes de escribir ni una línea, llama al advisor.

Opus recibe el historial completo y devuelve tres cosas que Sonnet había pasado por alto:

1. La función `switchLanguage()` está inline en `defuddle-yourself.html`. Si la copias tal cual en cada post acabas con N copias divergentes. Mejor extraerla a `lang-toggle.js` y enlazarla con un `<script src="../lang-toggle.js">` en el `<head>`.
2. El `onclick="switchLanguage('es')"` rompe accesibilidad por teclado y choca con cualquier CSP estricto. Mejor `data-lang="es"` y un `addEventListener` delegado en el contenedor.
3. El idioma elegido no persiste entre páginas. Si el lector cambia a EN en un post y navega a otro, vuelve a ES. Dos líneas de `localStorage` en el módulo extraído lo arreglan para todos los posts a la vez.

Eso es una review de senior en mitad del flow, sin que tú tengas que pararlo. Sonnet aplica los tres puntos y entrega un resultado que de otro modo habría necesitado una segunda pasada tuya.

| Setup                 | Input | Output | Inteligencia |
| --------------------- | ----- | ------ | ------------ |
| Sonnet solo           | $3    | $15    | Baseline     |
| Opus solo             | $5    | $25    | Máxima       |
| Sonnet + Opus advisor | $3    | $15    | SemiOpus     |

Deleguemos cuando los modelos necesitan o no sacarse de la chistera un advisor.

## [ENG]

Another day, another attempt to help the token-poor (like me). What if Sonnet could ask Opus for help only when it needs it, instead of charging you Opus-level all the time? With one line in your request. No sub-agents, no orchestration, no moving context around by hand building plans.

For simple tasks Sonnet is plenty, but when things get hairy it struggles. The obvious fix is to reach for Opus, but [Opus costs `$5/$25` per million tokens and Sonnet `$3/$15`](https://www.anthropic.com/claude/opus). That is, the price depends on whether it's input or output. Given this gap, it's not always clear which one to use and we can burn through our precious tokens.

The [advisor tool](https://claude.com/blog/the-advisor-strategy) is Anthropic's answer to this dilemma. You put Sonnet as the executor and give it access to an `advisor tool` backed by Opus. Sonnet decides on its own when to call the advisor: before a big decision, before writing critical code, when it's lost. When it calls, the entire conversation history is forwarded automatically to Opus, which returns its take. No manual handoff. Not a sub-agent.

The interesting part is the numbers. In Anthropic's benchmarks, Sonnet + Opus advisor improves on BrowseComp2 and Terminal-Bench 2.0 **and costs less per task than Sonnet alone**. Haiku with Opus as advisor scores 41.2% on BrowseComp — more than double Haiku's solo 19.7% — at 85% less per task than Sonnet. Sounds like magic but isn't: the tool only fires when the executor asks for it, so you pay Opus in bursts and Sonnet/Haiku the rest of the time.

If you use Claude Code, you enable it with one command:

```
/advisor
```

Available from v2.1.101. Pick an advisor model (Opus), and from there Sonnet calls it when it needs to. Nothing else to configure.

If you use it via API, three things: the `anthropic-beta: advisor-tool-2026-03-01` header, the `advisor_20260301` tool in your tools array, and the advisor model inside the tool definition (not in the main `model` field). Add `max_uses` too to cap spend per request:

```bash
curl https://api.anthropic.com/v1/messages \
  --header "x-api-key: $ANTHROPIC_API_KEY" \
  --header "anthropic-version: 2023-06-01" \
  --header "anthropic-beta: advisor-tool-2026-03-01" \
  --header "content-type: application/json" \
  --data '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 4096,
    "tools": [{
      "type": "advisor_20260301",
      "name": "advisor",
      "model": "claude-opus-4-7",
      "max_uses": 3
    }],
    "messages": [{"role": "user", "content": "..."}]
  }'
```

A real case to better grasp the use case. You ask Sonnet: *"add an ES/EN language toggle to `prozbul.html`, just like the one already in `defuddle-yourself.html`"*. Sonnet opens the file, sees the pattern (`<div class="language-toggle">`, an inline `switchLanguage()`, two `<div class="lang-section">`), and goes for a copy-paste of the structure. Reasonable plan. But before writing a single line, it calls the advisor.

Opus receives the full history and returns three things Sonnet had missed:

1. The `switchLanguage()` function is inlined in `defuddle-yourself.html`. Copy it as-is into every post and you'll end up with N divergent copies. Better extract it to `lang-toggle.js` and wire it up with a `<script src="../lang-toggle.js">` in the `<head>`.
2. The `onclick="switchLanguage('es')"` breaks keyboard accessibility and clashes with any strict CSP. Use `data-lang="es"` and a delegated `addEventListener` on the container instead.
3. The chosen language doesn't persist across pages. If a reader switches to EN in one post and navigates away, the next post resets to ES. Two lines of `localStorage` in the extracted module fix it for every post at once.

That's a senior-level review in the middle of the flow, without you having to stop anything. Sonnet applies the three fixes and delivers a change that would've otherwise needed a second pass from you.

|Setup|Input|Output|Intelligence|
|---|---|---|---|
|Sonnet solo|$3|$15|Baseline|
|Opus solo|$5|$25|Max|
|Sonnet + Opus advisor|$3|$15|SemiOpus|

Let’s delegate when the models need to—or don’t need to—pull an advisor out of a hat.