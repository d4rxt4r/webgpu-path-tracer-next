"""Export the full Stanford reconstruction as OBJ without modifying its mesh."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
URL = "https://graphics.stanford.edu/pub/3Dscanrep/happy/happy_recon.tar.gz"
ARCHIVE_SHA256 = "409cd294efbfd8244e15a382b95a9423f153b7776e736c9b09f19ec9d3c10ed0"
with urllib.request.urlopen(URL, timeout=60) as response:
    archive_bytes = response.read()
assert hashlib.sha256(archive_bytes).hexdigest() == ARCHIVE_SHA256, "Unexpected source archive"
with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
    source_bytes = archive.extractfile("happy_recon/happy_vrip.ply").read()
assert hashlib.sha256(source_bytes).hexdigest() == "2283371216d748a08376a3c88698e283cc8f18d10ced348d6d133051bcf217ab"
source = source_bytes.decode("ascii").splitlines()
end = source.index("end_header")
assert source[1] == "format ascii 1.0"
vertices = int(next(line.split()[-1] for line in source[:end] if line.startswith("element vertex ")))
faces = int(next(line.split()[-1] for line in source[:end] if line.startswith("element face ")))
assert (vertices, faces) == (543652, 1087716)
lines = ["# Stanford Computer Graphics Laboratory, Happy Buddha; full happy_vrip.ply",
         "# Format conversion only; original coordinates and face order", "o HappyBuddha", "s 1"]
for line in source[end + 1:end + 1 + vertices]:
    assert len(line.split()) == 3
    lines.append("v " + line)
for line in source[end + 1 + vertices:]:
    indices = list(map(int, line.split()))
    assert indices[0] == 3 and len(indices) == 4
    assert all(0 <= i < vertices for i in indices[1:])
    lines.append("f " + " ".join(str(i + 1) for i in indices[1:]))
assert len(lines) == 4 + vertices + faces
output = ("\n".join(lines) + "\n").encode("ascii")
target = ROOT / "assets" / "Buddha.obj"
target.write_bytes(output)
metadata = {"source": "Stanford University Computer Graphics Laboratory, Happy Buddha",
            "sourceUrl": "https://graphics.stanford.edu/data/3Dscanrep/", "downloadUrl": URL,
            "sourceArchiveSha256": ARCHIVE_SHA256, "sourceFile": "happy_recon/happy_vrip.ply",
            "vertices": vertices, "triangles": faces, "objSha256": hashlib.sha256(output).hexdigest(),
            "conversion": "PLY to OBJ only; original coordinates, face indices and components"}
(ROOT / "assets" / "Buddha-source.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
print(f"{target}: {vertices} vertices, {faces} triangles, {len(output)} bytes")
