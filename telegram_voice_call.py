#!/usr/bin/env python3
"""Place a one-to-one Telegram VoIP call from a logged-in user account.

Telegram's Bot API cannot start calls. This helper uses MTProto user methods
and NTgCalls for the encrypted WebRTC media path. The outgoing call plays the
local SomniSync alert WAV to the recipient.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import wave
from pathlib import Path
from typing import Any

from pyrogram import Client
from pyrogram.handlers import RawUpdateHandler
from pyrogram.raw import functions, types
import ntgcalls


ROOT = Path(__file__).resolve().parent
SESSION_NAME = "somnisync_telegram_user"
ALERT_FILE = Path(os.environ.get("TELEGRAM_ALERT_FILE", str(ROOT / "somnisync_emergency.wav")))
SESSION_STRING = os.environ.get("TELEGRAM_SESSION_STRING", "").strip()
CALL_TIMEOUT_SECONDS = 40
ALERT_REPEAT_COUNT = 2
ALERT_REPEAT_PAUSE_SECONDS = 1.5
CALL_VERSIONS = ["8.0.0", "9.0.0", "12.0.0", "13.0.0"]


def emit(status: str, message: str) -> None:
    print(json.dumps({"status": status, "message": message}, ensure_ascii=True), flush=True)


def client_from_env() -> Client:
    api_id = os.environ.get("TELEGRAM_API_ID", "").strip()
    api_hash = os.environ.get("TELEGRAM_API_HASH", "").strip()
    if not api_id.isdigit() or len(api_hash) != 32:
        raise RuntimeError("Telegram API ID/API hash are missing or invalid.")
    return Client(
        SESSION_NAME,
        api_id=int(api_id),
        api_hash=api_hash,
        session_string=SESSION_STRING or None,
        workdir=str(ROOT),
        no_updates=False,
    )


def call_protocol() -> types.PhoneCallProtocol:
    return types.PhoneCallProtocol(
        udp_p2p=True,
        udp_reflector=True,
        min_layer=92,
        max_layer=200,
        library_versions=CALL_VERSIONS,
    )


def build_rtc_servers(connections: list[Any]) -> list[Any]:
    servers = []
    for connection in connections:
        if isinstance(connection, types.PhoneConnectionWebrtc):
            servers.append(
                ntgcalls.RTCServer(
                    connection.id,
                    connection.ip,
                    connection.ipv6,
                    connection.port,
                    connection.username,
                    connection.password,
                    connection.turn,
                    connection.stun,
                    False,
                    None,
                )
            )
        elif isinstance(connection, types.PhoneConnection):
            servers.append(
                ntgcalls.RTCServer(
                    connection.id,
                    connection.ip,
                    connection.ipv6,
                    connection.port,
                    None,
                    None,
                    True,
                    False,
                    connection.tcp,
                    connection.peer_tag,
                )
            )
    if not servers:
        raise RuntimeError("Telegram did not return any usable call relay servers.")
    return servers


def external_audio_description() -> Any:
    return ntgcalls.AudioDescription(
        media_source=ntgcalls.MediaSource.EXTERNAL,
        sample_rate=48000,
        channel_count=1,
        input="",
        keep_open=False,
    )


def read_alert() -> bytes:
    if not ALERT_FILE.is_file():
        raise RuntimeError("The emergency voice file is missing; restart using start_somnisync_live.ps1.")
    with wave.open(str(ALERT_FILE), "rb") as audio:
        if audio.getframerate() != 48000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise RuntimeError("Emergency voice WAV must be 48 kHz, mono, 16-bit PCM.")
        data = audio.readframes(audio.getnframes())
    if not data:
        raise RuntimeError("The emergency voice file is empty.")
    return data


async def login(export_session: bool = False) -> None:
    client = client_from_env()
    try:
        await client.start()
        account = await client.get_me()
        if account is None or account.is_bot:
            raise RuntimeError("Sign in with a Telegram user account; bot accounts cannot place calls.")
        if export_session:
            print(f"TELEGRAM_SESSION_STRING={await client.export_session_string()}")
        else:
            print("Telegram user session saved.")
    finally:
        if client.is_connected:
            await client.stop()


async def call_recipient() -> None:
    target = os.environ.get("TELEGRAM_CALL_TO", "").strip()
    if not target:
        raise RuntimeError("TELEGRAM_CALL_TO must be the recipient's Telegram @username.")
    alert = read_alert()
    client = client_from_env()
    ntg = ntgcalls.NTgCalls()
    loop = asyncio.get_running_loop()
    accepted: asyncio.Future[bytes] = loop.create_future()
    discarded: asyncio.Future[str] = loop.create_future()
    connected: asyncio.Future[None] = loop.create_future()
    incoming_signals: asyncio.Queue[bytes | None] = asyncio.Queue()
    outgoing_signals: asyncio.Queue[bytes | None] = asyncio.Queue()
    early_call_updates: list[Any] = []
    early_signaling_updates: list[tuple[int, bytes]] = []
    call_id: int | None = None
    access_hash: int | None = None
    user_id: int | None = None
    def on_connection_change(_peer_id: int, info: Any) -> None:
        state = getattr(getattr(info, "state", info), "name", str(info)).upper()
        if "CONNECTED" in state:
            def mark_connected() -> None:
                if not connected.done():
                    connected.set_result(None)
            loop.call_soon_threadsafe(mark_connected)
        elif "FAILED" in state or "TIMEOUT" in state:
            def mark_failed() -> None:
                if not connected.done():
                    connected.set_exception(RuntimeError(f"Telegram media connection {state.lower()}."))
            loop.call_soon_threadsafe(mark_failed)

    def on_signaling(_peer_id: int, data: bytes) -> None:
        loop.call_soon_threadsafe(outgoing_signals.put_nowait, bytes(data))

    ntg.on_connection_change(on_connection_change)
    ntg.on_signaling_data(on_signaling)

    def handle_phone_call_update(phone_call: Any) -> None:
        if call_id is None or getattr(phone_call, "id", None) != call_id:
            return
        if isinstance(phone_call, types.PhoneCallAccepted) and not accepted.done():
            accepted.set_result(bytes(phone_call.g_b))
        elif isinstance(phone_call, types.PhoneCallDiscarded) and not discarded.done():
            reason = type(phone_call.reason).__name__ if phone_call.reason else "unknown"
            discarded.set_result(reason)

    async def on_update(_client: Client, update: Any, _users: Any, _chats: Any) -> None:
        nonlocal call_id
        if isinstance(update, types.UpdatePhoneCallSignalingData):
            if call_id is None:
                early_signaling_updates.append((update.phone_call_id, bytes(update.data)))
            elif update.phone_call_id == call_id:
                await incoming_signals.put(bytes(update.data))
            return
        if not isinstance(update, types.UpdatePhoneCall):
            return
        phone_call = update.phone_call
        if call_id is None:
            early_call_updates.append(phone_call)
        else:
            handle_phone_call_update(phone_call)

    async def signal_pumps() -> None:
        async def outgoing() -> None:
            while True:
                blob = await outgoing_signals.get()
                if blob is None:
                    return
                if call_id is None or access_hash is None:
                    continue
                await client.invoke(
                    functions.phone.SendSignalingData(
                        peer=types.InputPhoneCall(id=call_id, access_hash=access_hash),
                        data=blob,
                    )
                )

        async def incoming() -> None:
            while True:
                blob = await incoming_signals.get()
                if blob is None:
                    return
                if user_id is not None:
                    await ntg.send_signaling_data(user_id, blob)

        return await asyncio.gather(outgoing(), incoming())

    pump_task: asyncio.Task[Any] | None = None
    try:
        await client.start()
        account = await client.get_me()
        if account is None or account.is_bot:
            raise RuntimeError("Sign in with a Telegram user account; bot accounts cannot place calls.")
        peer = await client.resolve_peer(target if target.startswith("@") else f"@{target}")
        if not isinstance(peer, types.InputPeerUser):
            raise RuntimeError("Recipient must be a Telegram user account with a username.")
        user_id = peer.user_id
        input_user = types.InputUser(user_id=peer.user_id, access_hash=peer.access_hash)
        client.add_handler(RawUpdateHandler(on_update))

        dh = await client.invoke(functions.messages.GetDhConfig(version=0, random_length=256))
        if not isinstance(dh, types.messages.DhConfig):
            raise RuntimeError("Telegram returned an invalid call key configuration.")
        await ntg.create_p2p_call(user_id)
        media = ntgcalls.MediaDescription(
            microphone=external_audio_description(),
            speaker=None,
            camera=None,
            screen=None,
        )
        await ntg.set_stream_sources(user_id, ntgcalls.StreamMode.CAPTURE, media)
        g_a_hash = await ntg.init_exchange(
            user_id,
            ntgcalls.DhConfig(dh.g, dh.p, dh.random),
        )
        result = await client.invoke(
            functions.phone.RequestCall(
                user_id=input_user,
                random_id=random.randint(1, 0x7FFFFFFE),
                g_a_hash=g_a_hash,
                protocol=call_protocol(),
                video=False,
            )
        )
        call_id = result.phone_call.id
        access_hash = result.phone_call.access_hash
        for signaling_call_id, data in early_signaling_updates:
            if signaling_call_id == call_id:
                incoming_signals.put_nowait(data)
        early_signaling_updates.clear()
        for early_update in early_call_updates:
            handle_phone_call_update(early_update)
        early_call_updates.clear()
        emit("placing", f"Telegram is calling {target}...")

        pump_task = asyncio.create_task(signal_pumps())
        done, _ = await asyncio.wait(
            {accepted, discarded},
            timeout=CALL_TIMEOUT_SECONDS,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if not done:
            raise TimeoutError("Recipient did not answer the Telegram call.")
        if discarded in done:
            raise RuntimeError(f"Telegram call ended before it connected ({discarded.result()}).")

        g_b = accepted.result()
        auth = await ntg.exchange_keys(user_id, g_b, 0)
        confirmed = await client.invoke(
            functions.phone.ConfirmCall(
                peer=types.InputPhoneCall(id=call_id, access_hash=access_hash),
                g_a=auth.g_a_or_b,
                key_fingerprint=auth.key_fingerprint,
                protocol=call_protocol(),
            )
        )
        phone_call = confirmed.phone_call
        custom_parameters = (
            phone_call.custom_parameters.data
            if getattr(phone_call, "custom_parameters", None)
            else None
        )
        await ntg.connect_p2p(
            user_id,
            build_rtc_servers(phone_call.connections),
            list(phone_call.protocol.library_versions),
            phone_call.p2p_allowed,
            custom_parameters,
        )
        await asyncio.wait_for(connected, timeout=25)
        emit("accepted", f"Telegram call connected; playing the SomniSync emergency alert to {target}.")

        frame_bytes = 480 * 2
        frame_data = ntgcalls.FrameData(0, ntgcalls.VideoRotation.VIDEO_ROTATION_0, 0, 0)
        for repetition in range(ALERT_REPEAT_COUNT):
            for offset in range(0, len(alert), frame_bytes):
                chunk = alert[offset : offset + frame_bytes]
                if len(chunk) < frame_bytes:
                    chunk = chunk + b"\x00" * (frame_bytes - len(chunk))
                frame_started = loop.time()
                await ntg.send_external_frame(
                    user_id,
                    ntgcalls.StreamDevice.MICROPHONE,
                    chunk,
                    frame_data,
                )
                remaining = 0.01 - (loop.time() - frame_started)
                if remaining > 0:
                    await asyncio.sleep(remaining)
            if repetition + 1 < ALERT_REPEAT_COUNT:
                await asyncio.sleep(ALERT_REPEAT_PAUSE_SECONDS)
        emit("accepted", "Emergency voice alert finished; ending the Telegram call.")

    finally:
        if call_id is not None and access_hash is not None and client.is_connected:
            try:
                await client.invoke(
                    functions.phone.DiscardCall(
                        peer=types.InputPhoneCall(id=call_id, access_hash=access_hash),
                        duration=0,
                        reason=types.PhoneCallDiscardReasonHangup(),
                        connection_id=0,
                        video=False,
                    )
                )
            except Exception:
                pass
        for queue in (incoming_signals, outgoing_signals):
            try:
                queue.put_nowait(None)
            except Exception:
                pass
        if pump_task is not None:
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):
                pass
        try:
            if user_id is not None:
                await ntg.stop(user_id)
        except Exception:
            pass
        if client.is_connected:
            await client.stop()


async def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--login", action="store_true")
    mode.add_argument("--export-session", action="store_true", help="Print a deployable session string after login.")
    mode.add_argument("--call", action="store_true")
    args = parser.parse_args()

    if args.export_session and not args.login:
        parser.error("--export-session requires --login")

    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    try:
        if args.login:
            await login(export_session=args.export_session)
        else:
            await call_recipient()
        return 0
    except asyncio.CancelledError:
        emit("cancelled", "Telegram emergency call cancelled.")
        return 0
    except Exception as error:
        emit("error", f"{type(error).__name__}: {error}")
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        emit("cancelled", "Telegram setup cancelled.")
        raise SystemExit(130)
