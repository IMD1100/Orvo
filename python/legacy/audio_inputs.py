"""Native audio reading with a session-local FFmpeg fallback."""
from pathlib import Path
import subprocess
import tempfile
import uuid

import soundfile as sf

from tool_catalog import ROOT

EXTENSIONS = ("wav", "wave", "flac", "mp3", "m4a", "aac", "ogg", "oga", "opus", "wma", "aif", "aiff", "aifc", "caf")
FILE_FILTER = "音频 (" + " ".join("*." + item for item in EXTENSIONS) + ");;全部文件 (*)"
_cache_directory = None
_temporary = None
_decoded = {}


def configure_cache(directory):
    global _cache_directory
    _cache_directory = Path(directory)
    _cache_directory.mkdir(parents=True, exist_ok=True)
    _decoded.clear()


def decode_audio(source, output):
    import imageio_ffmpeg
    flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
    try:
        result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(source), "-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "pcm_f32le", "-f", "wav", "-y", str(output)], capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=flags)
        if result.returncode:
            raise ValueError("无法解码音频，请检查文件是否完整或受加密保护：" + source.name)
        with sf.SoundFile(str(output)) as handle:
            if len(handle) < 64:
                raise ValueError("音频内容过短或为空。")
    except Exception:
        output.unlink(missing_ok=True)
        raise


def open_audio(path):
    global _temporary
    source = Path(path).resolve()
    if not source.is_file():
        raise ValueError("音频文件不存在：" + str(source))
    stat = source.stat()
    key = (str(source), stat.st_size, stat.st_mtime_ns)
    if key in _decoded:
        return sf.SoundFile(str(_decoded[key]))
    try:
        return sf.SoundFile(str(source))
    except sf.LibsndfileError:
        if _cache_directory is None:
            base = ROOT / ".cache"
            base.mkdir(exist_ok=True)
            _temporary = tempfile.TemporaryDirectory(prefix="decoded_", dir=base, ignore_cleanup_errors=True)
            configure_cache(_temporary.name)
        output = _cache_directory / (uuid.uuid4().hex + ".wav")
        decode_audio(source, output)
        _decoded[key] = output
        return sf.SoundFile(str(output))
