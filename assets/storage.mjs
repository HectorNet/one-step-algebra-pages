// One read/write transaction per command prevents cross-tab lost updates.
export const freshData=()=>({schema:1,profiles:[],runs:[],questions:[],attempts:[],steps:[],chats:[],events:[],progress:[],seq:0});
export function indexedStore(name='one-step-pages-v1'){
  let opening;
  function open(){
    opening||=new Promise((resolve,reject)=>{
      const request=indexedDB.open(name,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('state');
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(new Error('無法開啟本機紀錄。請使用允許網站儲存資料的瀏覽器。'));
      request.onblocked=()=>reject(new Error('請先關閉其他開著的體驗版頁籤，再重新整理。'));
    });return opening;
  }
  return {async transact(fn){
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('state','readwrite'),store=tx.objectStore('state'),request=store.get('data');
      let result,error;
      request.onsuccess=()=>{
        try{const data=request.result||freshData();if(data.schema!==1)throw new Error('本機資料版本不相容，請先保存原有紀錄。');result=fn(data);store.put(data,'data');}
        catch(e){error=e;tx.abort();}
      };
      tx.oncomplete=()=>resolve(result);
      tx.onabort=tx.onerror=()=>reject(error||new Error('本機紀錄儲存失敗，請匯出既有紀錄並檢查瀏覽器儲存空間。'));
    });
  }};
}
export function memoryStore(initial=freshData()){
  let data=structuredClone(initial),chain=Promise.resolve();
  return {transact(fn){const command=chain.then(()=>{const next=structuredClone(data),out=fn(next);data=next;return structuredClone(out);});chain=command.catch(()=>{});return command;}};
}
