# Agente simple de ventas

Extraído de la sección **Agente simple de ventas** de `original.ipynb`.
Incluye `sales_data.db`, descargada desde el enlace del notebook.

Repositorio: <https://github.com/juananpe/agente-ventas>

## Puesta en marcha con el contenedor (recomendada)

Solo necesitas [Docker](https://www.docker.com/products/docker-desktop/) y
[Visual Studio Code](https://code.visualstudio.com/) con la extensión
**Dev Containers**. Da igual si usas Windows, macOS o Linux.

1. Clona el repositorio:

```sh
git clone https://github.com/juananpe/agente-ventas.git
```

2. Abre esa carpeta en VS Code y elige **Reopen in Container**
   (`F1` → `Dev Containers: Reopen in Container`).

VS Code construye el contenedor y deja el entorno listo: Python 3.13, las
dependencias y el runtime del SDK. La primera vez tarda un par de minutos; las
siguientes son instantáneas.

3. Abre `.env` y pega tu clave de OpenRouter. Es el único paso manual:

```
OPENROUTER_API_KEY=tu_clave
```

Puedes crear una clave en <https://openrouter.ai/keys>. El `.env` ya existe (el
contenedor lo crea a partir de `.env.example`) y está excluido de Git, así que
tu clave no se sube al repositorio.

4. Ejecuta el agente en la terminal de VS Code:

```sh
python agente_ventas.py
```

También admite una pregunta única:

```sh
python agente_ventas.py --pregunta "¿Cuál es el top 5 de tiendas por ventas totales?"
```

Dentro del contenedor `python` ya apunta al entorno correcto: no hay que activar
nada ni usar rutas con `.venv`.

## Puesta en marcha sin Docker

Si prefieres ejecutarlo directamente en tu equipo necesitas Python 3.11 o
posterior. Crea el entorno virtual:

```sh
python3 -m venv .venv
```

macOS y Linux:

```sh
./.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env        # y pega tu clave en .env
./.venv/bin/python agente_ventas.py
```

Windows (PowerShell):

```powershell
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
.venv\Scripts\python agente_ventas.py
```

## Versión web

Además de la terminal, el agente tiene una interfaz web de chat (HTML y
JavaScript sin frameworks, con backend en FastAPI). Arráncala con:

```sh
python servidor_web.py
```

(sin contenedor: `.venv\Scripts\python servidor_web.py` en Windows o
`./.venv/bin/python servidor_web.py` en macOS y Linux) y abre
<http://127.0.0.1:8000> en el navegador.

Las respuestas aparecen a medida que el modelo las escribe, cada consulta SQL
que lanza el agente se puede desplegar para verla, y las preguntas de seguimiento
conservan el contexto hasta que pulses **Nueva conversación**.

Opciones: `--port` para otro puerto, `--modelo` para otro modelo y `--host` para
la dirección de escucha. Por defecto solo escucha en este equipo (`127.0.0.1`);
cada pregunta consume crédito de tu clave de OpenRouter, así que piénsalo antes
de usar `--host 0.0.0.0`, que la deja accesible desde la red.

Estructura:

- `servidor_web.py`: API (`POST /api/chat` con respuesta en streaming SSE,
  `GET /api/config`, `DELETE /api/conversations/{id}`) y servidor de `web/`.
- `web/index.html`, `web/styles.css`, `web/app.js`: la interfaz.
- `agente_ventas.py`: lógica compartida (herramienta SQL, prompt y creación de
  la sesión) y la versión de terminal.

## Detalles

Usa OpenRouter con el modelo `deepseek/deepseek-v4.1-flash`; puedes elegir otro
con `--modelo ID_DEL_MODELO`. En el modo interactivo, escribe `salir` para
terminar.

La clave se lee de `.env` al arrancar. Si `OPENROUTER_API_KEY` ya está definida
en el entorno, también la usa.

El SDK descarga su runtime nativo en el primer arranque (el contenedor de
desarrollo ya lo trae predescargado).

La base SQLite se abre en modo de solo lectura y se devuelven como máximo 100
filas por consulta.

Existe otra versión web anterior en la rama `codex/web`.
