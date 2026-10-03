"""Blender 4.4: --background --factory-startup --python-exit-code 1
--python scripts/prepare-buddha.py -- /path/to/happy_recon/happy_vrip.ply

Source: Stanford Computer Graphics Laboratory, Happy Buddha reconstruction.
Download/terms: https://graphics.stanford.edu/data/3Dscanrep/
The input archive stays outside the repository; the checked output is shipped.
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(sys.argv[sys.argv.index('--') + 1])
TARGET_TRIANGLES = 96000
HEIGHT = 1.7

bpy.ops.wm.read_factory_settings(use_empty=True)
# Stanford coordinates are already Y up. Disable Blender's importer axis rotation.
bpy.ops.wm.ply_import(filepath=str(SOURCE), forward_axis='Y', up_axis='Z')
obj = bpy.context.object
obj.name = 'Stanford Happy Buddha'
source_vertices = len(obj.data.vertices)
source_faces = len(obj.data.polygons)
modifier = obj.modifiers.new('WebGPU triangle budget', 'DECIMATE')
modifier.ratio = TARGET_TRIANGLES / source_faces
bpy.ops.object.modifier_apply(modifier=modifier.name)
bm = bmesh.new()
bm.from_mesh(obj.data)
bmesh.ops.triangulate(bm, faces=list(bm.faces))
bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
points = [vertex.co.copy() for vertex in bm.verts]
low = Vector(tuple(min(p[c] for p in points) for c in range(3)))
high = Vector(tuple(max(p[c] for p in points) for c in range(3)))
print('Source bounds', tuple(low), tuple(high), flush=True)
center = (low + high) / 2
scale = HEIGHT / (high.y - low.y)
for vertex in bm.verts:
    vertex.co = (vertex.co - center) * scale
bm.to_mesh(obj.data)
bm.free()
# The scan contains sub-resolution bridges that collapse to zero-area faces.
# Reconstruct at roughly the original scan's scaled resolution before final LOD.
remesh = obj.modifiers.new('Resolve sub-resolution scan bridges', 'REMESH')
remesh.mode = 'VOXEL'
remesh.voxel_size = 0.003
remesh.use_smooth_shade = True
bpy.ops.object.modifier_apply(modifier=remesh.name)
modifier = obj.modifiers.new('Final WebGPU triangle budget', 'DECIMATE')
obj.data.calc_loop_triangles()
modifier.ratio = min(1, TARGET_TRIANGLES / len(obj.data.loop_triangles))
bpy.ops.object.modifier_apply(modifier=modifier.name)
bm = bmesh.new()
bm.from_mesh(obj.data)
bmesh.ops.triangulate(bm, faces=list(bm.faces))
bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
components = []
unvisited = set(bm.verts)
while unvisited:
    seed = unvisited.pop()
    component = {seed}
    stack = [seed]
    while stack:
        vertex = stack.pop()
        for edge in vertex.link_edges:
            neighbor = edge.other_vert(vertex)
            if neighbor in unvisited:
                unvisited.remove(neighbor)
                component.add(neighbor)
                stack.append(neighbor)
    components.append(component)
largest = max(components, key=len)
bmesh.ops.delete(bm, geom=[v for component in components if component is not largest for v in component], context='VERTS')
bm.normal_update()
stats = {
    'vertices': len(bm.verts), 'faces': len(bm.faces),
    'boundaryEdges': sum(e.is_boundary for e in bm.edges),
    'nonManifoldEdges': sum(not e.is_manifold for e in bm.edges),
    'signedVolume': bm.calc_volume(signed=True),
}
assert stats['boundaryEdges'] == 0 and stats['nonManifoldEdges'] == 0
print('Prepared statistics', stats, flush=True)
assert stats['signedVolume'] > 0 and len(bm.faces) <= TARGET_TRIANGLES
bm.to_mesh(obj.data)
bm.free()
obj.data.update()
vertices = [tuple(v.co) for v in obj.data.vertices]
normals = [tuple(v.normal) for v in obj.data.vertices]
faces = [tuple(f.vertices) for f in obj.data.polygons]
assert all(abs(Vector(n).length - 1) < 1e-5 for n in normals), 'Non-unit output normal'
minimum_area = min((Vector(vertices[b])-Vector(vertices[a])).cross(Vector(vertices[c])-Vector(vertices[a])).length/2 for a,b,c in faces)
assert minimum_area > 1e-12, 'Degenerate output triangle'
count = len(vertices)
data = struct.pack('<8s6I', b'SGMESH01', count, len(faces), 32, 32 + count*12, 32 + count*24, 0)
data += struct.pack(f'<{count*3}f', *(c for v in vertices for c in v))
data += struct.pack(f'<{count*3}f', *(c for n in normals for c in n))
data += struct.pack(f'<{len(faces)*3}I', *(c for f in faces for c in f))
(ROOT / 'public/assets/buddha.bin').write_bytes(data)
metadata = {
    'asset': 'buddha.bin', 'format': 'SGMESH01', 'byteLength': len(data),
    'sha256': hashlib.sha256(data).hexdigest(),
    'source': 'Stanford University Computer Graphics Laboratory, Happy Buddha',
    'sourceUrl': 'https://graphics.stanford.edu/data/3Dscanrep/',
    'downloadUrl': 'https://graphics.stanford.edu/pub/3Dscanrep/happy/happy_recon.tar.gz',
    'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'sourceVertices': source_vertices, 'sourceTriangles': source_faces,
    'generator': 'scripts/prepare-buddha.py', 'blenderVersion': bpy.app.version_string,
    'pipeline': ['quadric decimation to 96000 triangles', 'outward normals', 'center bounds', 'normalize height to 1.7m', 'voxel reconstruction at 0.003m to resolve sub-resolution scan bridges', 'final quadric decimation to 96000 triangles', 'remove disconnected scan specks'],
    'terms': 'Free research use and free redistribution with attribution; commercial use requires Stanford permission. See sourceUrl and BUDDHA-NOTICES.txt.',
    'bounds': [[min(v[c] for v in vertices) for c in range(3)], [max(v[c] for v in vertices) for c in range(3)]],
    'finalStatistics': {**stats, 'components': 1}, 'triangles': len(faces),
    'removedDisconnectedScanSpecks': len(components)-1, 'minimumTriangleArea': minimum_area,
}
(ROOT / 'src/assets/buddha-meta.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
print(json.dumps(metadata), flush=True)
