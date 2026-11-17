document.getElementById("run").addEventListener("click", async event => {
  event.target.disabled = true;
  try {
    const health = await messenger.directClam.health();
    const normal = await messenger.directClam.scan("Subject: Synthetic test\r\n\r\nHello", "daemon");
    document.getElementById("result").textContent = JSON.stringify({ health, normal }, null, 2);
  } catch (error) { document.getElementById("result").textContent = error.message; }
  finally { event.target.disabled = false; }
});
