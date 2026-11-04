// Local CLI shares the app's worker, durable lease, source checks and versions.
import { loadConfig } from '../server/config.js';
import { openDb, getSetting, setSetting } from '../server/db.js';
import { startMatterBriefPass } from '../server/lib/matterBriefs.js';
const args=process.argv.slice(2);const flag=name=>args.includes(name);const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const config=loadConfig();const db=openDb(config.DB_PATH);
try{
 const options={mode:value('--matter')?'matter':flag('--nightly')?'nightly':'initial',...(value('--matter')?{matterId:Number(value('--matter'))}:{}),...(value('--through')?{throughDate:value('--through')}:{}),...(value('--from')?{fromDate:value('--from')}:{}),...(value('--model')?{model:value('--model')}: {})};
 const task=startMatterBriefPass({db,config,clock:()=>new Date()},options);
 if(!task)throw Error('A matter brief pass is already running.');
 console.log(JSON.stringify({run_id:task.run_id,...options}));
 const timer=setInterval(()=>{console.log(JSON.stringify(db.prepare('SELECT id,total,updated,skipped,errors_json FROM matter_brief_runs WHERE id=?').get(task.run_id)));},30_000);
 let result;try{result=await task.promise;}finally{clearInterval(timer);}
 console.log(JSON.stringify(result));
 if(flag('--enable')&&result.status==='complete')setSetting(db,'matterBriefs',{...getSetting(db,'matterBriefs'),enabled:true,...(options.model?{model:options.model}:{})});
 if(result.status!=='complete')process.exitCode=1;
}finally{db.close();}
