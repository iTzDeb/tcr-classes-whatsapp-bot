const ADMIN_USER_ID='499900380';
const TAB_TITLE='AuthorizedChats';
const HEADER='Chat ID';
function normalizeChatId(value) {
  const id=String(value==null?'':value).trim();
  return /^-?[1-9]\d{0,19}$/.test(id)?id:null;
}
function validate({sheets,spreadsheetId}) { if(!sheets||!spreadsheetId) throw new Error('Google Sheets client and spreadsheet ID are required.'); }
function findTab(data) { return (data.sheets||[]).find(x=>x.properties?.title===TAB_TITLE)?.properties; }
async function getOrCreateTab({sheets,spreadsheetId,initialChatId}) {
  validate({sheets,spreadsheetId});
  let book=await sheets.spreadsheets.get({spreadsheetId}); let tab=findTab(book.data);
  if(tab) return {title:TAB_TITLE,sheetId:tab.sheetId};
  let created;
  try {
    const result=await sheets.spreadsheets.batchUpdate({spreadsheetId,requestBody:{requests:[{addSheet:{properties:{title:TAB_TITLE}}}]}});
    created=result.data.replies?.[0]?.addSheet?.properties;
  } catch(error) {
    book=await sheets.spreadsheets.get({spreadsheetId}); tab=findTab(book.data);
    if(!tab) throw error;
    return {title:TAB_TITLE,sheetId:tab.sheetId};
  }
  if(!created||!Number.isInteger(created.sheetId)) throw new Error('Google Sheets did not return the created AuthorizedChats tab.');
  const rows=[[HEADER]], seed=normalizeChatId(initialChatId);
  if(seed&&seed!==ADMIN_USER_ID) rows.push([seed]);
  await sheets.spreadsheets.values.update({spreadsheetId,range:`'${TAB_TITLE}'!A1:A${rows.length}`,valueInputOption:'RAW',requestBody:{values:rows}});
  return {title:TAB_TITLE,sheetId:created.sheetId};
}
async function readTab(options) {
  const {sheets,spreadsheetId}=options, tab=await getOrCreateTab(options);
  const result=await sheets.spreadsheets.values.get({spreadsheetId,range:`'${tab.title}'!A1:A`});
  const rows=result.data.values||[];
  if(String(rows[0]?.[0]||'').trim()!==HEADER) throw new Error('AuthorizedChats tab must have a "Chat ID" header in cell A1.');
  return {tab,rows};
}
async function listAuthorizedChatIds(options) {
  const {rows}=await readTab(options), ids=[];
  for(const row of rows.slice(1)) { const id=normalizeChatId(row[0]); if(id&&!ids.includes(id)) ids.push(id); }
  return ids;
}
async function addAuthorizedChatId(options) {
  const id=normalizeChatId(options.chatId);
  if(!id) throw new Error('Chat ID must be a non-zero integer.');
  if(id===ADMIN_USER_ID) throw new Error('The administrator is permanently authorized and cannot be changed.');
  const {tab}=await readTab(options);
  if((await listAuthorizedChatIds(options)).includes(id)) return false;
  await options.sheets.spreadsheets.values.append({spreadsheetId:options.spreadsheetId,range:`'${tab.title}'!A:A`,valueInputOption:'RAW',insertDataOption:'INSERT_ROWS',requestBody:{values:[[id]]}});
  return true;
}
async function removeAuthorizedChatId(options) {
  const id=normalizeChatId(options.chatId);
  if(!id) throw new Error('Chat ID must be a non-zero integer.');
  if(id===ADMIN_USER_ID) throw new Error('The administrator is permanently authorized and cannot be changed.');
  const {tab,rows}=await readTab(options), indexes=[];
  rows.slice(1).forEach((row,i)=>{if(normalizeChatId(row[0])===id) indexes.push(i+1);});
  if(!indexes.length) return false;
  const requests=indexes.reverse().map(i=>({deleteDimension:{range:{sheetId:tab.sheetId,dimension:'ROWS',startIndex:i,endIndex:i+1}}}));
  await options.sheets.spreadsheets.batchUpdate({spreadsheetId:options.spreadsheetId,requestBody:{requests}});
  return true;
}
async function isAuthorizedChat({sheets,spreadsheetId,chatId,userId,initialChatId}) {
  if(String(userId??'')===ADMIN_USER_ID) return true;
  const id=normalizeChatId(chatId);
  return id ? (await listAuthorizedChatIds({sheets,spreadsheetId,initialChatId})).includes(id) : false;
}
module.exports={ADMIN_USER_ID,normalizeChatId,listAuthorizedChatIds,addAuthorizedChatId,removeAuthorizedChatId,isAuthorizedChat};
