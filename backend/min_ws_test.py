from fastapi import FastAPI, WebSocket
app = FastAPI()

@app.websocket("/audio")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    while True:
        await websocket.send_text("hello")
