import json
d=json.load(open('out/p7/staging2.json',encoding='utf-8'))['json'];print(d['changed'],d['added'],d['removed'],d['conflicts'])
t=json.load(open('out/p8-timings.json'))
t['apply_p6_native_failed']={"seconds":10.4,"note":"map var + Map_Add/Map_Find via call kinds: 6 wildcard compile errors, rolled back"}
t['apply_p6']={"seconds":9.4,"note":"raw graph AddAndFind with 6 resolved pins, ok"}
t['compile_p6']={"seconds":8.9}
t['game_test_p6']={"seconds":21.5}
t['apply_p7_create_struct']={"seconds":9.4,"note":"raw python StructureFactory create+save, BP_StructHost"}
t['apply_p7_probe_failed']={"seconds":8.7,"note":"struct:<path> without .Name -> invalid type Structure"}
t['apply_p7']={"seconds":8.6,"note":"struct:/.../S_Probe.S_Probe ok"}
t['compile_p7']={"seconds":8.8}
t['game_test_p7']={"seconds":19.7}
json.dump(t,open('out/p8-timings.json','w'),indent=1)
