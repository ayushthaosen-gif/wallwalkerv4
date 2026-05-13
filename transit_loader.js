// Merges the 4 stop_timings chunks into one BUS_STOP_TIMES object
// and loads metro_schedules + route_schedules from server API instead
window.BUS_STOP_TIMES = {};
(function merge(){
  [window._ST_P1,window._ST_P2,window._ST_P3,window._ST_P4].forEach(chunk=>{
    if(chunk) Object.assign(window.BUS_STOP_TIMES, chunk);
  });
  delete window._ST_P1; delete window._ST_P2;
  delete window._ST_P3; delete window._ST_P4;
  console.log('BUS_STOP_TIMES loaded:', Object.keys(window.BUS_STOP_TIMES).length, 'stops');
})();
