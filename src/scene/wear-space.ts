/** Symmetric polar stretch sqrt(A^T A). Column-major, double precision. */
export function wearMetric(transform: readonly number[], extent: number): number[] {
  const a = [0,1,2].flatMap(c => [0,1,2].map(r => transform[c*4+r]!));
  const magnitude = Math.max(...a.map(Math.abs));
  let r = a.map(v => v/magnitude);
  for(let iteration=0;iteration<64;iteration++) {
    const [a,b,c,d,e,f,g,h,i] = r as [number,number,number,number,number,number,number,number,number];
    const det=a*(e*i-f*h)-d*(b*i-c*h)+g*(b*f-c*e);
    if(!Number.isFinite(det)||det===0) throw new Error("Invalid surface wear metric");
    const inverseTranspose=[e*i-f*h,f*g-d*i,d*h-e*g,c*h-b*i,a*i-c*g,b*g-a*h,b*f-c*e,c*d-a*f,a*e-b*d].map(v=>v/det);
    const next=r.map((v,j)=>.5*(v+inverseTranspose[j]!));
    const delta=Math.max(...next.map((v,j)=>Math.abs(v-r[j]!)));
    r=next;if(delta<1e-12)break;
    if(iteration===63)throw new Error("Surface wear metric did not converge");
  }
  const out=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  for(let c=0;c<3;c++)for(let row=0;row<3;row++)out[c*4+row]=extent*[0,1,2].reduce((sum,k)=>sum+r[row*3+k]!*a[c*3+k]!,0);
  if(!out.every(Number.isFinite))throw new Error("Invalid surface wear metric");
  return out;
}
