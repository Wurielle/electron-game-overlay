const test=require('node:test');const assert=require('node:assert/strict');
const {readNativeImageRaster}=require('../dist/lib/native-image-raster.js');
function image(width,height,scale=1){
 const bitmap=Buffer.alloc(width*height*4,0x9c),calls=[];
 return {bitmap,calls,getScaleFactors:()=>[scale],getSize:()=>({width:Math.floor(width/scale),height:Math.floor(height/scale)}),
 toBitmap(o){calls.push(['bitmap',o]);assert.equal(o.scaleFactor,scale);return bitmap;},
 toPNG(o){calls.push(['png',o]);const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.write('IHDR',12);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return b;}};
}
test('paint pixels are decoded from their existing representation without resampling',()=>{
 for(const [w,h,s] of [[600,480,1],[750,600,1.25],[900,720,1.5],[752,601,1.25],[660,528,1.100000023841858]]){
 const i=image(w,h,s);const actual=readNativeImageRaster(i);
 assert.equal(actual.width,w);assert.equal(actual.height,h);assert.equal(actual.scaleFactor,s);assert.strictEqual(actual.bitmap,i.bitmap);
 assert.deepEqual(i.calls,[['bitmap',{scaleFactor:s}]]);
 }
});
test('fractional DIP ambiguity is resolved from the actual representation IHDR',()=>{
 const i=image(750,751,1.25);const actual=readNativeImageRaster(i);
 assert.equal(actual.width,750);assert.equal(actual.height,751);assert.equal(i.calls.at(-1)[0],'png');
});
test('bad bitmap bytes and contradictory geometry fail closed',()=>{
 const i=image(750,600,1.25);i.toBitmap=()=>Buffer.alloc(100);
 assert.throws(()=>readNativeImageRaster(i),/dimensions/);
 i.toBitmap=()=>Buffer.alloc(3);assert.throws(()=>readNativeImageRaster(i),/length/);
 i.getScaleFactors=()=>[NaN];assert.throws(()=>readNativeImageRaster(i),/scale/);
});
