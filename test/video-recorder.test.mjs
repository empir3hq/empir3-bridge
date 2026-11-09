import test from 'node:test';
import assert from 'node:assert/strict';
import {videoBlurRegions,videoConcat,VideoRecorder} from '../src/video-recorder.ts';

test('video concat preserves irregular wall-clock intervals and the final still frame',()=>{
  const list=videoConcat([{name:'frame-0.jpg',at:20},{name:'frame-1.jpg',at:175},{name:'frame-2.jpg',at:950}],2000);
  assert.match(list,/duration 0.175000/);assert.match(list,/duration 0.775000/);assert.match(list,/duration 1.050000/);
  assert.equal(list.match(/file 'frame-2.jpg'/g).length,2);
  assert.throws(()=>videoConcat([],1000),/No video frames/);
});
test('video blur accepts only bounded integer pixel rectangles',()=>{
  assert.deepEqual(videoBlurRegions([{x:0,y:5,width:200,height:80}]),[{x:0,y:5,width:200,height:80}]);
  for(const value of ['1:2:3:4',[{x:-1,y:0,width:100,height:20}],[{x:0,y:0,width:Infinity,height:20}],Array(9).fill({x:0,y:0,width:10,height:10})])assert.throws(()=>videoBlurRegions(value));
});
test('missing encoder refuses before opening a capture source',async()=>{
  const recorder=new VideoRecorder('/unused-test-video-root','nonexistent-empir3-ffmpeg');let attached=false;
  await assert.rejects(recorder.start({surface:'browser'},async()=>{attached=true;return async()=>{};}),/needs ffmpeg/);
  assert.equal(attached,false);assert.equal(recorder.status().state,'failed');
});
