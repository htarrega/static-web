| Field   | Content                                                  |
| ------- | -------------------------------------------------------- |
| Title   | Reduce, reuse, claudecode better                         |
| Date    | April 2026                                               |
| Excerpt | Want to reduce Claude Code's token consumption by 75%?      |
***

¿Quieres reducir el consumo de tokens de Claude Code un 75% de media? Sin tocar tu código. Sin cambiar tu workflow. Con un binario de Rust y un solo comando.

Claude Code usa muchos comandos: `grep`, `read`, `git log`... Todos ellos fueron pensados para ser leídos por humanos y contienen mucha información que no es útil para un LLM. Vamos a interceptar todos los usos de estos comandos, a eliminar todo lo superfluo y a quedarnos con lo que el modelo necesita. Ahorremos tokens y ventana de contexto.

[RTK](https://github.com/rtk-ai/rtk) (Rust Token Killer) es un proxy CLI escrito en Rust que hace de intermediario entre tu agente de código y la terminal. Intercepta la salida de más de 100 de estos comandos y la comprime antes de que lleguen al LLM. No modifica el comportamiento del comando, solo filtra la información.

Lo que RTK hace por debajo son cuatro cosas: elimina ruido (comentarios, whitespace, boilerplate), agrupa elementos similares (archivos por directorio, errores por tipo), trunca redundancia, y deduplica líneas de log repetidas. Cuando ejecutamos `rtk gain` obtenemos la siguiente tabla:

![RTK Token Savings — rtk gain mostrando 53.7% de tokens ahorrados en 51 comandos](https://cv.htarrega.me/articles/rtk-gain.png)

En esta sesión de ejemplo: 51 comandos, 15.6K tokens de entrada, 8.4K tokens ahorrados. Un 53.7% de ahorro sin cambiar absolutamente nada en la forma de trabajar. El comando más eficiente fue `git log --stat` con un 81.9% de reducción. Y cada comando añadió un overhead negligible de 18ms.

Lo instalas con dos líneas:
```
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh

echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc  # or ~/.zshrc
```

Y activarlo para Claude Code, otra:
```
rtk init -g
```

RTK no es solo para Claude Code. Soporta 10 herramientas de AI coding: Cursor, Copilot, Gemini CLI, Codex, Windsurf, Cline, y más. La instalación cambia ligeramente pero el principio es el mismo.

Además de ahorrar tokens, RTK incluye una red de seguridad: cuando un comando falla, guarda la salida completa sin filtrar en un archivo local. Si Claude necesita más detalle sobre un error, lo tiene disponible sin tener que re-ejecutar nada.

Overhead minusculo por comando para acabar ahorrando un 75% promedio en mas de 100 comandos.

## [ENG]

Want to reduce Claude Code's token consumption by 75% on average? Without touching your code. Without changing your workflow. With a Rust binary and a single command.

Claude Code uses many commands: `grep`, `read`, `git log`... All of them were designed to be read by humans and contain a lot of information that isn't useful for an LLM. We're going to intercept all uses of these commands, strip out everything superfluous, and keep only what the model needs. Let's save tokens and context window.

RTK (Rust Token Killer) is a CLI proxy written in Rust that acts as a middleman between your coding agent and the terminal. It intercepts the output of over 100 of these commands and compresses it before it reaches the LLM. It doesn't modify the command's behavior — it only filters the information.

What RTK does under the hood comes down to four things: it removes noise (comments, whitespace, boilerplate), groups similar elements (files by directory, errors by type), truncates redundancy, and deduplicates repeated log lines. When we run `rtk gain` we get the following table:

![RTK Token Savings — rtk gain showing 53.7% token savings across 51 commands](https://cv.htarrega.me/articles/rtk-gain.png)

In this example session: 51 commands, 15.6K input tokens, 8.4K tokens saved. A 53.7% savings without changing absolutely anything about the way you work. The most efficient command was `git log --stat` with an 81.9% reduction. And each command added a negligible overhead of 18ms.

You install it with two lines:

```
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh

echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc  # or ~/.zshrc
```

And activate it for Claude Code with one more:

```
rtk init -g
```

RTK isn't just for Claude Code. It supports 10 AI coding tools: Cursor, Copilot, Gemini CLI, Codex, Windsurf, Cline, and more. The installation varies slightly, but the principle is the same.

Beyond saving tokens, RTK includes a safety net: when a command fails, it saves the complete unfiltered output to a local file. If Claude needs more detail about an error, it's available without having to re-run anything.

Tiny overhead per command to end up saving 75% on average across over 100 commands.
