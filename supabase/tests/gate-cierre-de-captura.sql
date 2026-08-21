\set ON_ERROR_STOP on
begin;
-- Fuente y snapshots de juguete. Todo dentro de una transacción que se revierte.
insert into catalog_sources(source_key,name,authority,adapter,base_url,is_active)
values ('prueba-gate','Prueba del gate','official','html','https://ejemplo.test',false)
returning id \gset fuente_

create temp table snaps(caso text, id uuid);

-- Caso A · una URL descubierta que nunca se intentó
insert into catalog_source_snapshots(source_id,status,started_at,completed_at,metadata)
values (:'fuente_id','succeeded',now(),now(),'{"declared_total":3}') returning id \gset a_
insert into snaps values ('A · una URL sin intentar', :'a_id');
insert into capture_url_ledger(snapshot_id,source_id,url,url_sha256,outcome,attempts,artifact_sha256,error_class) values
 (:'a_id',:'fuente_id','https://ejemplo.test/1',repeat('a',64),'CAPTURED',1,repeat('a',64),null),
 (:'a_id',:'fuente_id','https://ejemplo.test/2',repeat('b',64),'CAPTURED',1,repeat('b',64),null),
 (:'a_id',:'fuente_id','https://ejemplo.test/3',repeat('c',64),'TEMPORARY_ERROR_PENDING',0,null,'SIN_INTENTAR');

-- Caso B · dos URLs distintas compartiendo artefacto (la sobrescritura de 2.142)
insert into catalog_source_snapshots(source_id,status,started_at,completed_at,metadata)
values (:'fuente_id','succeeded',now(),now(),'{"declared_total":2}') returning id \gset b_
insert into snaps values ('B · dos URLs, un artefacto', :'b_id');
insert into capture_url_ledger(snapshot_id,source_id,url,url_sha256,outcome,attempts,artifact_sha256) values
 (:'b_id',:'fuente_id','https://ejemplo.test/x',repeat('d',64),'CAPTURED',1,repeat('f',64)),
 (:'b_id',:'fuente_id','https://ejemplo.test/y',repeat('e',64),'CAPTURED',1,repeat('f',64));

-- Caso C · descubrimiento corto: la fuente declara 10 y solo vimos 2 (el 649/2583)
insert into catalog_source_snapshots(source_id,status,started_at,completed_at,metadata)
values (:'fuente_id','succeeded',now(),now(),'{"declared_total":10}') returning id \gset c_
insert into snaps values ('C · descubrimiento corto', :'c_id');
insert into capture_url_ledger(snapshot_id,source_id,url,url_sha256,outcome,attempts,artifact_sha256) values
 (:'c_id',:'fuente_id','https://ejemplo.test/p',repeat('1',64),'CAPTURED',1,repeat('1',64)),
 (:'c_id',:'fuente_id','https://ejemplo.test/q',repeat('2',64),'CAPTURED',1,repeat('2',64));

-- Caso D · el bueno: todo explicado, con una ausencia y un error permanente
insert into catalog_source_snapshots(source_id,status,started_at,completed_at,metadata)
values (:'fuente_id','succeeded',now(),now(),'{"declared_total":4}') returning id \gset d_
insert into snaps values ('D · completo con bajas explicadas', :'d_id');
insert into capture_url_ledger(snapshot_id,source_id,url,url_sha256,outcome,attempts,artifact_sha256,http_status,error_class) values
 (:'d_id',:'fuente_id','https://ejemplo.test/m',repeat('3',64),'CAPTURED',1,repeat('3',64),200,null),
 (:'d_id',:'fuente_id','https://ejemplo.test/n',repeat('4',64),'CAPTURED',1,repeat('4',64),200,null),
 (:'d_id',:'fuente_id','https://ejemplo.test/o',repeat('5',64),'VALID_ABSENCE',1,null,404,null),
 (:'d_id',:'fuente_id','https://ejemplo.test/r',repeat('6',64),'PERMANENT_ERROR',2,null,403,'HTTP_403');

select s.caso,
       a.descubiertas, a.capturadas, a.ausencias, a.permanentes, a.pendientes,
       a.colisiones_de_artefacto as colis,
       a.puede_declararse_completa as completa,
       a.motivo
from snaps s join capture_closure_audit_v1 a on a.snapshot_id = s.id
order by s.caso;
rollback;
