'use strict';
const CRS_LIST = [
      {
        id: 'EPSG:4326',
        label: 'WGS84 경위도 (DD) - EPSG:4326',
        proj: '+proj=longlat +datum=WGS84 +no_defs',
        type: 'dd'
      },
      {
        id: 'WGS84_DMS',
        label: 'WGS84 경위도 (DMS)',
        proj: '+proj=longlat +datum=WGS84 +no_defs',
        type: 'dms'
      },
      {
        id: 'EPSG:32652',
        label: 'UTM 한국 Zone 52N - EPSG:32652',
        proj: '+proj=utm +zone=52 +datum=WGS84 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'KATEC_TM128',
        label: 'KATEC / TM128 (비 EPSG 사용자 정의)',
        proj: '+proj=tmerc +lat_0=38 +lon_0=128 +k=0.9999 +x_0=400000 +y_0=600000 +ellps=bessel +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.09,1.92 +units=m +no_defs',
        type: 'projected'
      },

      {
        id: 'EPSG:5173',
        label: 'Korean 1985 / Modified West Belt - EPSG:5173',
        proj: '+proj=tmerc +lat_0=38 +lon_0=125.002890277778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-145.907,505.034,685.756,-1.162,2.347,1.592,6.342 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5174',
        label: 'Korean 1985 / Modified Central Belt - EPSG:5174',
        proj: '+proj=tmerc +lat_0=38 +lon_0=127.002890277778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-145.907,505.034,685.756,-1.162,2.347,1.592,6.342 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5175',
        label: 'Korean 1985 / Modified Central Belt Jeju - EPSG:5175',
        proj: '+proj=tmerc +lat_0=38 +lon_0=127.002890277778 +k=1 +x_0=200000 +y_0=550000 +ellps=bessel +towgs84=-145.907,505.034,685.756,-1.162,2.347,1.592,6.342 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5176',
        label: 'Korean 1985 / Modified East Belt - EPSG:5176',
        proj: '+proj=tmerc +lat_0=38 +lon_0=129.002890277778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-145.907,505.034,685.756,-1.162,2.347,1.592,6.342 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5178',
        label: 'Korean 1985 / Unified CS - EPSG:5178',
        proj: '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=bessel +towgs84=-145.907,505.034,685.756,-1.162,2.347,1.592,6.342 +units=m +no_defs +type=crs',
        type: 'projected'
      },

      {
        id: 'EPSG:5179',
        label: 'KGD2002 / Unified CS - EPSG:5179',
        proj: '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5180',
        label: 'KGD2002 / West Belt - EPSG:5180',
        proj: '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5181',
        label: 'KGD2002 / Central Belt - EPSG:5181',
        proj: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5183',
        label: 'KGD2002 / East Belt - EPSG:5183',
        proj: '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5185',
        label: 'KGD2002 / West Belt 2010 - EPSG:5185',
        proj: '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5186',
        label: 'KGD2002 / Central Belt 2010 - EPSG:5186',
        proj: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
        type: 'projected'
      },
      {
        id: 'EPSG:5187',
        label: 'KGD2002 / East Belt 2010 - EPSG:5187',
        proj: '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
        type: 'projected'
      }
    ];

