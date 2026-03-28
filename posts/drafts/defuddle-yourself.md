| Field   | Content                                    |
| ------- | ------------------------------------------ |
| Title   | Defuddle yourself                          |
| Date    | March 2026                                 |
| Excerpt | Do you want to reduce your token usage by 10x? |
***

¿Quieres reducir 10x tu uso de tokens? In this economy? Sí. Con un hook de 15 líneas.

Hay un problema que todos aceptamos sin pararnos a pensar. Cada vez que Claude Code necesita leer una página web, llama a `WebFetch` y recibe el HTML entero: navbars, footers, scripts de tracking, banners de cookies, anuncios, CSS inline. Son miles de tokens que no aportan nada. Como pedirle a alguien que te cuente una noticia y que te lea el periódico entero.

Tú pagas por esos tokens. Y Claude los procesa todos, ensuciando además tu ventana de contexto. ¿Cómo arreglamos esto? [Defuddle](https://github.com/kepano/defuddle) es una herramienta de Kepano — el creador de Obsidian — que hace una sola cosa: recibe una URL, extrae el contenido principal y te lo devuelve en markdown. Esto elimina los tokens que no aportan valor, como se puede ver en esta tabla comparativa sobre obtener la página de [documentacion de lldb](https://lldb.llvm.org/use/mcp.html):

| Método   | ~Tokens | vs Defuddle |
| -------- | ------- | ----------- |
| Raw HTML | 11,116  | 16x more    |
| Defuddle | 682     | baseline    |

Los hooks de Claude Code permiten interceptar herramientas antes de que se ejecuten. Combinando ambas cosas, podemos meter un `PreToolUse` que atrape cada llamada a `WebFetch`, corra Defuddle, le pase a Claude el markdown limpio como contexto, y bloquee el fetch original. Claude nunca ve el HTML. Solo recibe lo que importa.

Primero instala la herramienta con:

`npm install -g defuddle`

Para configurarlo, agrega esto a `~/.claude/settings.json`. Si lo copias y lo pegas en Claude Code, lo hará el mismo.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "WebFetch",
        "hooks": [
          {
            "type": "command",
            "command": "python3 -c \"\nimport json, sys, subprocess\ndata = json.load(sys.stdin)\nurl = data.get('tool_input', {}).get('url', '')\nresult = subprocess.run(['npx', 'defuddle', 'parse', url, '--markdown'], capture_output=True, text=True)\ncontent = result.stdout if result.returncode == 0 else result.stderr\nprint(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': f'Webpage content (via defuddle) for {url}:\\n\\n{content}', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Content fetched via defuddle; see additionalContext'}}))\n\"",
            "timeout": 30,
            "statusMessage": "Fetching page with defuddle"
          }
        ]
      }
    ]
  }
}
```

El resultado no es solo ahorro. Es que Claude piensa mejor cuando no tiene que desenterrar el sentido de entre escombros de HTML. Más espacio en la ventana de contexto y más dinero en forma de tokens para ti.

## [ENG]
Do you want to reduce your token usage by 10x? In this economy? Yes. With a 15-line hook.

There's a problem we all accept without stopping to think about it. Every time Claude Code needs to read a web page, it calls `WebFetch` and receives the entire HTML: navbars, footers, tracking scripts, cookie banners, ads, inline CSS. Thousands of tokens that add nothing. It's like asking someone to tell you the news and having them read you the entire newspaper.

You pay for those tokens. And Claude processes all of them, polluting your context window in the process. How do we fix this? [Defuddle](https://github.com/kepano/defuddle) is a tool by Kepano — the creator of Obsidian — that does one thing: it takes a URL, extracts the main content, and returns it as markdown. This eliminates tokens that add no value, as you can see in this comparison table for fetching the [lldb documentation page](https://lldb.llvm.org/use/mcp.html):

| Method   | ~Tokens | vs Defuddle |
| -------- | ------- | ----------- |
| Raw HTML | 11,116  | 16x more    |
| Defuddle | 682     | baseline    |

Claude Code hooks let you intercept tools before they execute. Combining both, we can set up a `PreToolUse` that catches every `WebFetch` call, runs Defuddle, passes Claude the clean markdown as context, and blocks the original fetch. Claude never sees the HTML. It only gets what matters.

First, install the tool with:

`npm install -g defuddle`

To set it up, add this to `~/.claude/settings.json`. If you copy and paste it into Claude Code, it'll do it itself.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "WebFetch",
        "hooks": [
          {
            "type": "command",
            "command": "python3 -c \"\nimport json, sys, subprocess\ndata = json.load(sys.stdin)\nurl = data.get('tool_input', {}).get('url', '')\nresult = subprocess.run(['npx', 'defuddle', 'parse', url, '--markdown'], capture_output=True, text=True)\ncontent = result.stdout if result.returncode == 0 else result.stderr\nprint(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': f'Webpage content (via defuddle) for {url}:\\n\\n{content}', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Content fetched via defuddle; see additionalContext'}}))\n\"",
            "timeout": 30,
            "statusMessage": "Fetching page with defuddle"
          }
        ]
      }
    ]
  }
}
```

The result isn't just savings. Claude thinks better when it doesn't have to dig meaning out of HTML rubble. More room in the context window and more money in the form of tokens back in your pocket.
