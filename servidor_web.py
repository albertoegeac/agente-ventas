#!/usr/bin/env python3
"""Versión web del agente de ventas: API en FastAPI y frontend estático en web/."""

import argparse
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import json
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import uvicorn

from copilot.session_events import SessionEventType

from agente_ventas import DEFAULT_MODEL, ROOT, create_client, create_session, get_api_key


WEB_DIR = ROOT / "web"
MAX_CONVERSATIONS = 50
TURN_TIMEOUT = 300.0

EXAMPLE_QUESTIONS = [
    "¿Cuál es el top 5 de tiendas por ventas totales?",
    "¿Cómo han evolucionado las ventas mes a mes?",
    "¿Qué porcentaje de las ventas se hace en promoción?",
    "¿Cuáles son las 10 clases de producto con más unidades vendidas?",
]


@dataclass
class Conversation:
    session: object
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Cola del turno en curso; los eventos del SDK se reenvían aquí.
    queue: asyncio.Queue | None = None


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    conversation_id: str | None = None


class AppState:
    def __init__(self, model: str):
        self.model = model
        self.client = None
        self.conversations: dict[str, Conversation] = {}

    async def new_conversation(self) -> tuple[str, Conversation]:
        if len(self.conversations) >= MAX_CONVERSATIONS:
            # Descarta la conversación más antigua para no acumular sesiones abiertas.
            oldest_id = next(iter(self.conversations))
            await self.close_conversation(oldest_id)
        session = await create_session(self.client, self.model)
        conversation = Conversation(session=session)
        loop = asyncio.get_running_loop()

        def on_event(event):
            queue = conversation.queue
            if queue is not None:
                loop.call_soon_threadsafe(queue.put_nowait, event)

        session.on(on_event)
        conversation_id = uuid.uuid4().hex
        self.conversations[conversation_id] = conversation
        return conversation_id, conversation

    async def close_conversation(self, conversation_id: str) -> None:
        conversation = self.conversations.pop(conversation_id, None)
        if conversation is not None:
            try:
                await conversation.session.disconnect()
            except Exception:
                pass


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def extract_sql(arguments) -> str | None:
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            return arguments
    if isinstance(arguments, dict):
        return arguments.get("sql")
    return None


def create_app(model: str) -> FastAPI:
    state = AppState(model)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        get_api_key()  # Falla al arrancar si no hay clave, no en la primera pregunta.
        state.client = create_client()
        await state.client.start()
        try:
            yield
        finally:
            for conversation_id in list(state.conversations):
                await state.close_conversation(conversation_id)
            await state.client.stop()

    app = FastAPI(title="Agente de ventas", lifespan=lifespan)

    @app.get("/api/config")
    async def config():
        return {"model": state.model, "examples": EXAMPLE_QUESTIONS}

    @app.post("/api/chat")
    async def chat(request: ChatRequest):
        message = request.message.strip()
        if not message:
            raise HTTPException(status_code=400, detail="El mensaje está vacío")

        if request.conversation_id and request.conversation_id in state.conversations:
            conversation_id = request.conversation_id
            conversation = state.conversations[conversation_id]
        else:
            conversation_id, conversation = await state.new_conversation()

        if conversation.lock.locked():
            raise HTTPException(status_code=409, detail="Ya hay una pregunta en curso en esta conversación")

        async def stream():
            async with conversation.lock:
                queue: asyncio.Queue = asyncio.Queue()
                conversation.queue = queue
                yield sse("meta", {"conversation_id": conversation_id})
                turn = asyncio.create_task(
                    conversation.session.send_and_wait(message, timeout=TURN_TIMEOUT)
                )
                try:
                    while True:
                        getter = asyncio.create_task(queue.get())
                        done, _ = await asyncio.wait({getter, turn}, return_when=asyncio.FIRST_COMPLETED)
                        if getter in done:
                            event = getter.result()
                            if event.type == SessionEventType.ASSISTANT_MESSAGE_DELTA:
                                if event.data.delta_content:
                                    yield sse("delta", {"text": event.data.delta_content})
                            elif event.type == SessionEventType.TOOL_EXECUTION_START:
                                sql = extract_sql(event.data.arguments)
                                if sql:
                                    yield sse("tool", {"id": event.data.tool_call_id, "sql": sql})
                            elif event.type == SessionEventType.TOOL_EXECUTION_COMPLETE:
                                yield sse("tool_done", {"id": event.data.tool_call_id, "ok": event.data.success})
                            elif event.type == SessionEventType.SESSION_ERROR:
                                yield sse("error", {"message": str(event.data)})
                            continue
                        getter.cancel()
                        # Vacía los eventos que llegaron justo antes de terminar el turno.
                        while not queue.empty():
                            event = queue.get_nowait()
                            if event.type == SessionEventType.ASSISTANT_MESSAGE_DELTA and event.data.delta_content:
                                yield sse("delta", {"text": event.data.delta_content})
                        break
                    turn.result()
                    yield sse("done", {})
                except Exception as exc:
                    yield sse("error", {"message": str(exc) or exc.__class__.__name__})
                finally:
                    conversation.queue = None
                    if not turn.done():
                        # El navegador cortó la conexión: detenemos el trabajo del agente.
                        turn.cancel()
                        try:
                            await conversation.session.abort()
                        except Exception:
                            pass

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.delete("/api/conversations/{conversation_id}", status_code=204)
    async def delete_conversation(conversation_id: str):
        await state.close_conversation(conversation_id)

    @app.get("/")
    async def index():
        return FileResponse(WEB_DIR / "index.html")

    app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Servidor web del agente de ventas")
    parser.add_argument("--host", default="127.0.0.1", help="Dirección de escucha (por defecto solo este equipo)")
    parser.add_argument("--port", type=int, default=8000, help="Puerto HTTP")
    parser.add_argument("--modelo", default=DEFAULT_MODEL, help="Modelo de OpenRouter")
    args = parser.parse_args()
    print(f"📊 Agente de ventas en http://{args.host}:{args.port}  (Ctrl+C para terminar)")
    uvicorn.run(create_app(args.modelo), host=args.host, port=args.port, log_level="warning")
