fn xyzToLinearRgb(xyz: vec3f) -> vec3f {
  return vec3f(dot(vec3f(3.2404542,-1.5371385,-0.4985314),xyz), dot(vec3f(-0.969266,1.8760108,0.041556),xyz), dot(vec3f(0.0556434,-0.2040259,1.0572252),xyz));
}
