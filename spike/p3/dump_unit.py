import re,json,sys
u=json.load(open("spike/out/p3/unit.json"));own=set(u["owned"])
txt=open("spike/out/ref/BP_SoupInfoRelay.export.t3d",encoding="utf-8").read().split("\n")
def short(n): return n.replace("K2Node_","")
out=[]
i=0
n=len(txt)
while i<n:
    l0=txt[i]
    m=re.match(r'\s*Begin Object Name="([^"]+)" ExportPath=',l0)
    if m and m.group(1) in own and ":EventGraph." in l0:
        name=m.group(1); out.append("## "+name)
        i+=1
        while i<n and "End Object" not in txt[i]:
            l=txt[i].strip()
            if l.startswith("CustomProperties Pin"):
                pn=re.search(r'PinName="([^"]*)"',l).group(1)
                d="OUT" if 'EGPD_Output' in l else "IN "
                cat=re.search(r'PinCategory="([^"]*)"',l).group(1)
                sub=re.search(r'PinSubCategory="([^"]*)"',l).group(1)
                so=re.search(r'PinSubCategoryObject=("[^"]*"|None)',l).group(1)
                so=so.split("/")[-1].strip("\"'") if so!="None" else ""
                lt=re.search(r'LinkedTo=\(([^)]*)\)',l)
                links=[x.strip().split(" ")[0] for x in lt.group(1).split(",") if x.strip()] if lt else []
                dv=re.search(r'DefaultValue="([^"]*)"',l); do=re.search(r'DefaultObject=([^,]*),',l)
                hid="H" if "bHidden=True" in l else ""
                if cat=="exec" and not links and d=="OUT": i+=1; continue
                out.append("   %s %s %s %s %s %s %s %s %s"%(d,pn,cat,sub,so,hid,("->"+",".join(short(x) for x in links)) if links else "", ("def="+dv.group(1)) if dv and dv.group(1) else "", ("obj="+do.group(1)) if do and do.group(1)!="None" else ""))
            elif "ShowPinForProperties" not in l and not l.startswith("Begin Object"): out.append("   | "+l[:200])
            i+=1
    i+=1
open("spike/out/p3/orig_graph.txt","w",encoding="utf-8").write("\n".join(out))
print(len(out))
