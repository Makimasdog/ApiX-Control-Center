document.querySelector('#owner-login').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget;
  try{const response=await fetch('/api/owner/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:form.elements.token.value})});form.reset();if(!response.ok)throw new Error('令牌不正确，请查看本机数据目录。');location.reload();}catch(error){document.querySelector('#owner-error').textContent=error.message;}
});
