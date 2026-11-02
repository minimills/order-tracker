-- 0002_seed_machine_types.sql
-- Adds the machine types. Every type starts at serial number 1.
-- IMPORTANT: before entering real orders, set "next_serial_number" for each
-- type to the next serial you would actually use (e.g. 2073 for LCR if the
-- last Large Carder was LCR-2072). Do this in Table Editor -> machine_types.

insert into public.machine_types (name, code) values
  ('Washer',               'SSM'),
  ('Picker',               'PKR'),
  ('Separator - Large',    'LFS'),
  ('Carder - Large',       'LCR'),
  ('Draw Frame',           'DFE'),
  ('8 Spinner/Plyer',      'SPP8'),
  ('Cone Winder',          'CWR'),
  ('Skein Winder',         'SKW'),
  ('Hank Twister',         'HKT'),
  ('Vacuum Box',           'VCB'),
  ('Rug Yarn Maker',       'RYM'),
  ('Roving Deck',          'RVD');

-- Types whose code will be filled in later (code left empty).
insert into public.machine_types (name, code) values
  ('Steamer',                       null),
  ('Felter',                        null),
  ('Tumbler',                       null),
  ('Dye Vat',                       null),
  ('Carder - Artisan',              null),
  ('Carder - XL',                   null),
  ('Separator - Artisan',           null),
  ('Separator - Large Double',      null),
  ('Separator - XL',                null),
  ('4 Spinner',                     null),
  ('4 Spinner/Plyer',               null),
  ('8 Spinner',                     null),
  ('4 Lace Weight',                 null),
  ('4 Lace Weight/Plyer',           null),
  ('8 Lace Weight',                 null),
  ('8 Lace Weight/Plyer',           null),
  ('Skein Winder - Hank Twister',   null),
  ('Ball Winder',                   null),
  ('Drying Rack',                   null);
