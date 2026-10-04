// Browser-side experiments. None of these candidates silently changes production.
export function candidateShader(source, candidate) {
  source = source.replaceAll("\r\n", "\n");
  if (candidate === "bvh4") {
    const start = source.indexOf(
      "      if (node.first >= arrayLength(&nodes) - 1u)",
    );
    const end = source.indexOf("\n    }\n  }", start);
    if (start < 0 || end < 0) throw Error("BVH4 traversal marker mismatch");
    return (
      source.slice(0, start) +
      `
      if(node.first>=arrayLength(&nodes)-3u){return failHit(ray,1u,visits);}
      var distances:array<f32,4>;var children:array<u32,4>;var count=0u;
      for(var child=0u;child<4u;child++){
        let index=node.first+child;if(nodes[index].count==NO_HIT){continue;}
        let near=boundsNear(ray,nodes[index],best.t);if(near==FAR){continue;}
        var position=count;
        while(position>0u){if(distances[position-1u]<=near){break;}distances[position]=distances[position-1u];children[position]=children[position-1u];position--;}
        distances[position]=near;children[position]=index;count++;
      }
      if(size+count>STACK_SIZE){return failHit(ray,2u,visits);}
      for(var child=count;child>0u;child--){stack[size]=children[child-1u];size++;}
` +
      source.slice(end)
    );
  }
  if (candidate === "reciprocal-bounds") {
    if (source.includes("fn boundsNearPrepared")) return source;
    source = source
      .replace(
        "fn boundsNear(ray: Ray, node: BvhNode, limit: f32) -> f32 {",
        "fn boundsNearPrepared(ray: Ray, node: BvhNode, limit: f32, reciprocal: vec3f) -> f32 {",
      )
      .replace(
        "(node.min[axis] - ray.origin[axis]) / ray.direction[axis]",
        "(node.min[axis] - ray.origin[axis]) * reciprocal[axis]",
      )
      .replace(
        "(node.max[axis] - ray.origin[axis]) / ray.direction[axis]",
        "(node.max[axis] - ray.origin[axis]) * reciprocal[axis]",
      );
    const start = source.indexOf("fn traceBvh"),
      end = source.indexOf("fn closestHit", start);
    const trace = source
      .slice(start, end)
      .replace(
        "let shear = rayShear(ray.direction);",
        "let shear = rayShear(ray.direction);let reciprocal=1.0/ray.direction;",
      )
      .replace(
        "boundsNear(ray, node, best.t)",
        "boundsNearPrepared(ray,node,best.t,reciprocal)",
      )
      .replace(
        "boundsNear(ray, nodes[node.first], best.t)",
        "boundsNearPrepared(ray,nodes[node.first],best.t,reciprocal)",
      )
      .replace(
        "boundsNear(ray, nodes[node.first + 1u], best.t)",
        "boundsNearPrepared(ray,nodes[node.first+1u],best.t,reciprocal)",
      );
    return (
      source.slice(0, start) +
      "fn boundsNear(ray:Ray,node:BvhNode,limit:f32)->f32{return boundsNearPrepared(ray,node,limit,1.0/ray.direction);}\n" +
      trace +
      source.slice(end)
    );
  }
  if (candidate === "cached-bounds") {
    source = source.replace(
      "if (boundsNearPrepared(ray, node, best.t, reciprocal) == FAR)",
      "if (boundsNear(ray, node, best.t) == FAR)",
    );
    return source
      .replace(
        "var stack: array<u32, 64>;",
        "var stack: array<u32, 64>;var stackNear:array<f32,64>;stackNear[0]=ray.tMin;",
      )
      .replace(
        "let index = stack[size];",
        "let index = stack[size];let savedNear=stackNear[size];",
      )
      .replace(
        "if (boundsNear(ray, node, best.t) == FAR) { continue; }",
        "if(index==0u){if(boundsNear(ray,node,best.t)==FAR){continue;}}else if(savedNear>best.t){continue;}",
      )
      .replace(
        "stack[size] = select(node.first, node.first + 1u, left <= right);",
        "stack[size] = select(node.first, node.first + 1u, left <= right);stackNear[size]=max(left,right);",
      )
      .replace(
        "stack[size + 1u] = select(node.first + 1u, node.first, left <= right);",
        "stack[size + 1u] = select(node.first + 1u, node.first, left <= right);stackNear[size+1u]=min(left,right);",
      )
      .replace(
        "stack[size] = node.first; size++;",
        "stack[size] = node.first;stackNear[size]=left; size++;",
      )
      .replace(
        "stack[size] = node.first + 1u; size++;",
        "stack[size] = node.first + 1u;stackNear[size]=right; size++;",
      );
  }
  if (candidate === "compact-triangles") {
    source = source.replace(
      "var<storage, read> triangles: array<Triangle>;",
      `var<storage, read> triangles: array<vec4u>;
fn triangleCount() -> u32 { return arrayLength(&triangles)/6u; }
fn geometryAt(index: u32) -> Triangle {
  let a=triangles[index*3u];let b=triangles[index*3u+1u];let c=triangles[index*3u+2u];
  return Triangle(bitcast<vec3f>(a.xyz),a.w,bitcast<vec3f>(b.xyz),b.w,bitcast<vec3f>(c.xyz),c.w,vec3f(0),0u,vec3f(0),0u,vec3f(0),0u);
}
fn triangleAt(index: u32) -> Triangle {
  var tri=geometryAt(index);let offset=triangleCount()*3u+index*3u;
  tri.na=bitcast<vec3f>(triangles[offset].xyz);tri.nb=bitcast<vec3f>(triangles[offset+1u].xyz);tri.nc=bitcast<vec3f>(triangles[offset+2u].xyz);return tri;
}`,
    );
    const split = source.indexOf("fn miss(");
    const header = source.slice(0, split),
      implementation = source
        .slice(split)
        .replaceAll("arrayLength(&triangles)", "triangleCount()")
        .replace(/triangles\[([^\]]+)\]/g, "triangleAt($1)")
        .replace(
          "triangleHitPrepared(bounded, triangleAt(i), shear)",
          "triangleHitPrepared(bounded, geometryAt(i), shear)",
        );
    return header + implementation;
  }
  return source;
}
export function compactTriangles(data) {
  const source = new Uint32Array(data),
    count = data.byteLength / 96;
  const destination = new Uint32Array(source.length);
  for (let i = 0; i < count; i++) {
    destination.set(source.subarray(i * 24, i * 24 + 12), i * 12);
    destination.set(
      source.subarray(i * 24 + 12, i * 24 + 24),
      count * 12 + i * 12,
    );
  }
  return destination;
}
export function wideNodes(data) {
  const words = new Uint32Array(data),
    floats = new Float32Array(data),
    output = [];
  const blank = () => {
    const node = new Uint32Array(8);
    node[7] = 0xffffffff;
    return node;
  };
  const area = (index) => {
    const offset = index * 8;
    const x = floats[offset + 4] - floats[offset],
      y = floats[offset + 5] - floats[offset + 1],
      z = floats[offset + 6] - floats[offset + 2];
    return 2 * (x * y + x * z + y * z);
  };
  const build = (source, target) => {
    output[target] = words.slice(source * 8, source * 8 + 8);
    if (words[source * 8 + 7] > 0) return;
    const first = words[source * 8 + 3],
      frontier = [first, first + 1];
    while (frontier.length < 4) {
      let choice = -1,
        best = -1;
      for (let i = 0; i < frontier.length; i++)
        if (words[frontier[i] * 8 + 7] === 0 && area(frontier[i]) > best) {
          choice = i;
          best = area(frontier[i]);
        }
      if (choice < 0) break;
      const child = words[frontier[choice] * 8 + 3];
      frontier.splice(choice, 1, child, child + 1);
    }
    const destination = output.length;
    output[target][3] = destination;
    output.push(blank(), blank(), blank(), blank());
    frontier.forEach((child, i) => build(child, destination + i));
  };
  output.push(blank());
  build(0, 0);
  const packed = new Uint32Array(output.length * 8);
  output.forEach((node, i) => packed.set(node, i * 8));
  return packed;
}
