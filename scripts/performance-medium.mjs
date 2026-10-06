/** Integer-only medium bookkeeping through local pointers; benchmark before use. */
export function pointerMedia(source) {
  source = source.replaceAll('\r\n', '\n');
  const original = source.match(/^fn changeMedium\([\s\S]*?^}/m)?.[0];
  if (!original) throw Error('Medium transition marker missing');
  const transition = original.replace('state: MediumSet', 'state: ptr<function,MediumSet>')
    .replace(' -> MediumSet', '')
    .replace('  var next=state;\n', '')
    .replaceAll('state.', '(*state).').replaceAll('next.', '(*state).')
    .replaceAll('return next;', 'return;');
  source = source.replace(original, transition)
    .replace('var next=changeMedium(state,hit.triangle,dot(geometricNormal(triangle),ray.direction)<0.0);',
      'var next=state;changeMedium(&next,hit.triangle,dot(geometricNormal(triangle),ray.direction)<0.0);')
    .replace('next=changeMedium(next,i,dot(geometricNormal(candidate),ray.direction)<0.0);',
      'changeMedium(&next,i,dot(geometricNormal(candidate),ray.direction)<0.0);');
  return source;
}
