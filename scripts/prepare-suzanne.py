"""Run with Blender 4.4.3: blender --background --factory-startup --python-exit-code 1 --python scripts/prepare-suzanne.py.

Generate one closed glass volume from Blender's Suzanne primitive. No downloaded model.
The final f32 mesh is checked again after normalization, including self-intersections.
"""
import hashlib
import json
import math
import struct
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parent.parent
VOXEL_SIZE = 0.035  # Blender primitive units, before the final 1.2m normalization.
WIDTH = 1.2


def mesh_statistics(mesh):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    visited = set()
    components = 0
    for vertex in bm.verts:
        if vertex in visited:
            continue
        components += 1
        visited.add(vertex)
        stack = [vertex]
        while stack:
            current = stack.pop()
            for edge in current.link_edges:
                neighbor = edge.other_vert(current)
                if neighbor not in visited:
                    visited.add(neighbor)
                    stack.append(neighbor)
    result = {
        "vertices": len(bm.verts), "faces": len(bm.faces), "components": components,
        "boundaryEdges": sum(edge.is_boundary for edge in bm.edges),
        "nonManifoldEdges": sum(not edge.is_manifold for edge in bm.edges),
        "signedVolume": bm.calc_volume(signed=True),
    }
    bm.free()
    return result


def self_intersections(vertices, faces):
    # Blender's BVHTree overlap callback performs triangle/triangle intersection;
    # Its native callback excludes shared edges and point-only vertex contact,
    # but retains crossings with a shared vertex and a positive-length segment.
    tree = BVHTree.FromPolygons(vertices, faces, all_triangles=True, epsilon=0.0)
    return [(a, b) for a, b in tree.overlap(tree) if a < b]


def apply_subdivision(obj, levels, name):
    modifier = obj.modifiers.new(name, 'SUBSURF')
    modifier.subdivision_type = 'CATMULL_CLARK'
    modifier.levels = levels
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def main():
    # Verify that the intersection check rejects an actual non-adjacent crossing.
    crossing = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0.2, 0.2, -1), (0.2, 0.2, 1), (0.8, 0.2, 0)]
    assert self_intersections(crossing, [(0, 1, 2), (3, 4, 5)]), "Self-intersection detector failed"
    shared_crossing = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0.5, 0.25, -1), (0.5, 0.25, 1)]
    assert self_intersections(shared_crossing, [(0, 1, 2), (0, 3, 4)]), "Shared-vertex crossing missed"
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.mesh.primitive_monkey_add()
    obj = bpy.context.object
    obj.name = 'Suzanne solid'
    source_stats = mesh_statistics(obj.data)
    source_dir = ROOT / 'assets' / 'source'
    source_dir.mkdir(parents=True, exist_ok=True)
    source_file = source_dir / 'suzanne.blend'
    # A saved primitive is the editable source; subsequent processing is reproducible here.
    bpy.ops.wm.save_as_mainfile(filepath=str(source_file), compress=True)

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    boundary = [edge for edge in bm.edges if edge.is_boundary]
    bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    capped_stats = mesh_statistics(obj.data)
    apply_subdivision(obj, 2, 'Smooth capped source')
    remesh = obj.modifiers.new('Union eyes and head; remove internal surfaces', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = VOXEL_SIZE
    remesh.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    union_stats = mesh_statistics(obj.data)
    assert union_stats['components'] == 1, 'Voxel union did not produce a single solid'
    assert union_stats['boundaryEdges'] == 0 and union_stats['nonManifoldEdges'] == 0 and union_stats['signedVolume'] > 0
    obj.data.calc_loop_triangles()
    union_intersections = self_intersections([tuple(v.co) for v in obj.data.vertices], [tuple(t.vertices) for t in obj.data.loop_triangles])
    assert not union_intersections, 'Voxel union self-intersects before final subdivision'
    apply_subdivision(obj, 1, 'Final surface subdivision')

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method='BEAUTY', ngon_method='BEAUTY')
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    # Blender: Z up, front -Y. Engine: Y up, front +Z. This rotation preserves orientation.
    points = [Vector((v.co.x, v.co.z, -v.co.y)) for v in bm.verts]
    low = Vector(tuple(min(point[c] for point in points) for c in range(3)))
    high = Vector(tuple(max(point[c] for point in points) for c in range(3)))
    center = (low + high) / 2
    scale = WIDTH / (high.x - low.x)
    for vertex, point in zip(bm.verts, points):
        vertex.co = (point - center) * scale  # Blender stores these coordinates as f32.
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    stats = mesh_statistics(obj.data)
    vertices = [tuple(vertex.co) for vertex in obj.data.vertices]
    normals = [tuple(vertex.normal) for vertex in obj.data.vertices]
    faces = [tuple(face.vertices) for face in obj.data.polygons]
    bounds = [[min(point[c] for point in vertices) for c in range(3)], [max(point[c] for point in vertices) for c in range(3)]]
    intersections = self_intersections(vertices, faces)
    minimum_area = min((Vector(vertices[b]) - Vector(vertices[a])).cross(Vector(vertices[c]) - Vector(vertices[a])).length / 2 for a, b, c in faces)
    assert stats['components'] == 1 and stats['boundaryEdges'] == 0 and stats['nonManifoldEdges'] == 0
    assert stats['signedVolume'] > 0 and minimum_area > 1e-12
    assert not intersections, f'Self-intersections after subdivision: {intersections[:10]}'
    assert 50000 <= len(faces) <= 100000, 'Triangle budget exceeded'
    assert all(math.isfinite(value) for vertex in vertices for value in vertex)
    assert all(abs(math.sqrt(sum(value * value for value in n)) - 1) < 1e-5 for n in normals)

    count = len(vertices)
    positions_offset, normals_offset, indices_offset = 32, 32 + count * 12, 32 + count * 24
    header = struct.pack('<8s6I', b'SGMESH01', count, len(faces), positions_offset, normals_offset, indices_offset, 0)
    data = header + struct.pack(f'<{count * 3}f', *(value for vertex in vertices for value in vertex))
    data += struct.pack(f'<{count * 3}f', *(value for n in normals for value in n))
    data += struct.pack(f'<{len(faces) * 3}I', *(value for face in faces for value in face))
    asset_dir = ROOT / 'public' / 'assets'
    asset_dir.mkdir(parents=True, exist_ok=True)
    (asset_dir / 'suzanne.bin').write_bytes(data)
    metadata = {
        'asset': 'suzanne.bin', 'format': 'SGMESH01', 'byteLength': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
        'source': 'Blender built-in Suzanne primitive', 'sourceUrl': 'https://www.blender.org/',
        'blenderVersion': bpy.app.version_string, 'blenderBuildHash': bpy.app.build_hash.decode(),
        'generator': 'scripts/prepare-suzanne.py', 'editableSource': 'assets/source/suzanne.blend',
        'generatorLicense': 'Blender GPL-2.0-or-later; output artwork is not covered by the application GPL',
        'licensingPolicy': 'https://www.blender.org/about/license/',
        'pipeline': ['cap 42 boundary edges', 'Catmull-Clark 2', 'voxel union', 'Catmull-Clark 1', 'triangulate', 'rotate to Y-up', 'center bounding box', 'normalize width'],
        'voxelSizePrimitiveUnits': VOXEL_SIZE, 'widthMeters': WIDTH, 'bounds': bounds,
        'sourceStatistics': source_stats, 'cappedStatistics': capped_stats, 'unionStatistics': union_stats,
        'finalStatistics': stats, 'triangles': len(faces), 'minimumTriangleArea': minimum_area,
        'selfIntersectionPairs': len(intersections), 'intersectionMethod': 'Blender BVHTree native triangle intersection callback',
        'intersectionPositiveControl': True, 'sharedVertexIntersectionPositiveControl': True,
        'unionSelfIntersectionPairs': len(union_intersections),
    }
    (ROOT / 'src' / 'assets' / 'suzanne-meta.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(metadata), flush=True)


if __name__ == '__main__':
    main()
