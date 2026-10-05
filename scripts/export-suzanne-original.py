"""Export Blender's untouched Suzanne primitive (no modifiers or mesh repair)."""
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parent.parent
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_monkey_add()
obj = bpy.context.object
assert len(obj.data.vertices) == 507 and len(obj.modifiers) == 0
target = ROOT / "assets" / "suzanne-original.obj"
# Use Blender's render tessellation without running its export triangulation
# modifier, and preserve f32 coordinates rather than the OBJ exporter's 6 decimals.
mesh = obj.data
mesh.calc_loop_triangles()
def y_up(vector):
    return (vector.x, vector.z, -vector.y)
lines = [f"# Blender {bpy.app.version_string}; original Suzanne, native render tessellation", "o Suzanne", "s off"]
lines += ["v " + " ".join(format(v, '.9g') for v in y_up(vertex.co)) for vertex in mesh.vertices]
lines += ["vn " + " ".join(format(v, '.9g') for v in y_up(polygon.normal)) for polygon in mesh.polygons]
lines += ["f " + " ".join(f"{v+1}//{triangle.polygon_index+1}" for v in triangle.vertices) for triangle in mesh.loop_triangles]
target.write_text("\n".join(lines) + "\n", encoding='utf-8')
print(f"Original Suzanne: {len(obj.data.vertices)} vertices, {len(obj.data.polygons)} polygons -> {target}")
