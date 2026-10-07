    if (material.kind == 2u || material.kind == 5u) {
      if(!PRECISE_TRANSPORT && needsPreciseOrigin(ray,triangle,hit)) {return PathResult(vec3f(0),5u,interactions);}
      var change:MediumChange;
      var eta=materialIor(material,wavelength);
      let ns=surface.normal;
      var orientedShading=select(ns,-ns,dot(ns,n)<0.0);
      if(material.kind==2u) {
        let entering=dot(ng,ray.direction)<0.0;
        change=previewMediumChange(&media,hit.triangle,entering);
        if(PRECISE_TRANSPORT) {
          beginMediumAtSurface(&media,ray,originLow,hit,&journal);
          change.medium=activeMedium(&media);change.error=journal.error;
        }
        if(change.error!=0u) {return PathResult(vec3f(0),change.error,interactions);}
        eta=mediumIor(change.medium,wavelength)/mediumIor(medium,wavelength);
        if(eta==1.0) {
          finishMediumAtSurface(&media,change,&journal,true);medium=activeMedium(&media);previousPosition=position;
          let event=DielectricSample(ray.direction,1.0,1u);
          let origin=transportOrigin(ray,originLow,triangle,hit,event.direction);
          ray=Ray(origin.position,0.0,event.direction,1e20);originLow=origin.residual;spawnedTriangle=hit.triangle;
          continue;
        }
        if(depth==maxDepth) {break;}
        orientedShading=select(-ns,ns,entering);
      }
      if(material.textureParams.x>0.0 && strategy!=2u && (lightCount>0u || environment.sampling.y>0.0)) {
        let light=sampleSceneLight(sample1D(sampleIndex,dimension,pixel,seed),vec2f(sample1D(sampleIndex,dimension+1u,pixel,seed),sample1D(sampleIndex,dimension+2u,pixel,seed)),lightCount,wavelength);
        let direct=roughDirect(material,position,triangle,hit,-ray.direction,n,orientedShading,eta,wavelength,light,strategy);
        if(direct.error!=0u) {return PathResult(vec3f(0),direct.error,interactions);}
        radiance+=beta*direct.radiance;
      }
      let event=sampleEditedDielectric(material,ray.direction,n,orientedShading,eta,wavelength,vec2f(sample1D(sampleIndex,dimension+3u,pixel,seed),sample1D(sampleIndex,dimension+4u,pixel,seed)),sample1D(sampleIndex,dimension+5u,pixel,seed),false);
      if(all(event.weight==vec3f(0))) {break;} beta*=event.weight;
      if(material.kind==2u) {
        finishMediumAtSurface(&media,change,&journal,event.transmitted!=0u);
        if(event.transmitted!=0u) {medium=activeMedium(&media);etaScale*=eta*eta;}
      }
      previousPosition=position;lightPosition=position;previousPdf=event.pdf;previousDelta=material.textureParams.x==0.0;
      if(depth>=4u) {
        beta=rouletteWeight(beta,etaScale,sample1D(sampleIndex,dimension+6u,pixel,seed));
        if(all(beta==vec3f(0))) {break;}
      }
      let origin=transportOrigin(ray,originLow,triangle,hit,event.direction);
      ray=Ray(origin.position,0.0,event.direction,1e20);originLow=origin.residual;spawnedTriangle=hit.triangle;
      depth++;crossings=0u;continue;
    }
