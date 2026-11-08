#!/usr/bin/env python3
"""Deep profile of one live bot over all its matches: bids by letter class,
round, balance; whether its tiles end up in 7+ words; completion bids; word
lengths and timing. Usage: tools/bot_profile.py "LexForge-Base-v1" [Astronaut]"""
import json,collections,statistics as st,sys,urllib.request
URL="https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql"
def q(sql):
    r=urllib.request.urlopen(urllib.request.Request(URL,data=sql.encode(),method="POST"),timeout=120)
    x=json.loads(r.read())[0]; cols=[e["name"]["some"] for e in x["schema"]["elements"]]
    return [dict(zip(cols,row)) for row in x["rows"]]
_b={b['id']:b['name'] for b in q('SELECT * FROM bot')}
_t={v:k for k,v in _b.items()}[sys.argv[1]]
_lo=min(p['match_id'] for p in q(f'SELECT * FROM match_participant WHERE bot_id = {_t}'))-1
_lo=max(_lo, max(p['match_id'] for p in q(f'SELECT * FROM match_participant WHERE bot_id = {_t}'))-400)
d=dict(mp=q(f'SELECT * FROM match_participant WHERE match_id > {_lo}'),wp=q(f'SELECT * FROM word_play WHERE match_id > {_lo}'),ar=q(f'SELECT * FROM auction_result WHERE match_id > {_lo}'),tb=q(f'SELECT * FROM auction_top_bid_archive WHERE match_id > {_lo}'),ms=q(f'SELECT * FROM match_state WHERE id > {_lo}'),bots=[{'id':k,'name':v} for k,v in _b.items()])
bots={b['id']:b['name'] for b in d['bots']}; ids={v:k for k,v in bots.items()}


ended=set(m['id'] for m in d['ms'] if m['status'][0]==2)
tb={t['auction_id']:t['top_bid'] for t in d['tb']}
ar=collections.defaultdict(list)
for a in d['ar']: ar[a['match_id']].append(a)
wp=collections.defaultdict(list)
for w in d['wp']: wp[w['match_id']].append(w)
VAL=dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ",[1,3,3,2,1,4,2,4,1,8,5,1,3,1,1,3,10,1,1,1,1,4,4,8,4,10]))
def profile(NAME):
    B=ids[NAME]
    ms=[m for m in ended if any(p['match_id']==m and p['bot_id']==B for p in d['mp'])]
    rows=[]  # (round, letter, bid, paid, balance_before, used_in_word_len, completes_word)
    words_info=[]
    for m in ms:
        A=sorted(ar[m],key=lambda a:a['auction_id']); W=sorted([w for w in wp[m] if w['bot_id']==B],key=lambda w:w['played_at'][0])
        ev=[(a['closed_at'][0],0,a) for a in A]+[(w['played_at'][0],1,w) for w in W]
        ev.sort(key=lambda e:(e[0],e[1]))
        bal=100; rnd=0; held=collections.Counter(); won_seq=[]
        for t,k,x in ev:
            if k==0:
                rnd+=1
                if x['winner_bot_id']==[0,B]:
                    rows.append(dict(m=m,r=rnd,L=x['letter'],bid=tb.get(x['auction_id'],0),paid=x['paid'],bal=bal,aid=x['auction_id']))
                    bal-=x['paid']; held[x['letter']]+=1
            else:
                bal+=x['total_reward']
                words_info.append((rnd,len(x['word']),x['word'],x['total_reward']))
                # tiles in this word that were bought: mark the most recent rows
                for c in x['word']:
                    for r in reversed(rows):
                        if r['m']==m and r['L']==c and 'used' not in r: r['used']=len(x['word']); r['usedRound']=rnd; break
        # completion: tile won within 1 round before a word using it
    for r in rows: r['complete']= r.get('usedRound',999)-r['r']<=1
    n=len(ms)
    print(f"{NAME}: {n} matches, {len(rows)/n:.1f} tiles/match")
    def show(title,sel):
        v=[r['bid'] for r in sel]; 
        if v: print(f"  {title:38s} n={len(v):4d} bid mean {st.mean(v):5.1f} med {st.median(v):4.0f}  paid {st.mean(r['paid'] for r in sel):5.1f}")
    for cls,letters in [('vowel','AEIOU'),('common cons','DGLNRST'),('mid','BCFHMPVWY'),('high','JKQXZ')]:
        show(cls,[r for r in rows if r['L'] in letters])
    for lo,hi in [(1,17),(18,34),(35,51),(52,68)]:
        show(f"rounds {lo}-{hi}",[r for r in rows if lo<=r['r']<=hi])
    for lo,hi in [(0,40),(40,80),(80,130),(130,999)]:
        show(f"balance {lo}-{hi}",[r for r in rows if lo<=r['bal']<hi])
    show("tile later used in 7+ word",[r for r in rows if r.get('used',0)>=7])
    show("tile used in 2-6 word",[r for r in rows if 0<r.get('used',0)<7])
    show("tile never played",[r for r in rows if 'used' not in r])
    show("tile completing a word (<=1 round)",[r for r in rows if r['complete']])
    used=sum(1 for r in rows if 'used' in r); print(f"  bought tiles that got played: {100*used/len(rows):.0f}%")
    lens=collections.Counter(l for _,l,_,_ in words_info); print("  word lengths",sorted(lens.items()))
    print("  7+ words: rounds",sorted(r for r,l,_,_ in words_info if l>=7)[::max(1,len(words_info)//25)])
    print("  avg reward 7+:",round(st.mean(rw for _,l,_,rw in words_info if l>=7),1),"5-6:",round(st.mean([rw for _,l,_,rw in words_info if 5<=l<=6] or [0]),1))
    # bid per letter value
    byv=collections.defaultdict(list)
    for r in rows: byv[VAL[r['L']]].append(r['bid'])
    print("  bid by face value",{k:round(st.mean(v),1) for k,v in sorted(byv.items())})

for _n in sys.argv[1:]:
    profile(_n)
